#!/usr/bin/env python3
"""Read-only design decision retrieval, freshness and provenance checks.

Decisions live in `--records` (canonical registry); evidence is examined in `--root` (the checkout under
review, e.g. a task worktree). Approval is never read from a repository file: `approved` requires an
attestation in the ledger passed with `--approvals`, written only by the JabutiStudio server.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # evidence root: the checkout being examined (--root)
RECORDS = ROOT / "docs" / "design_knowledge" / "records"  # canonical decisions (--records)
DECISION_STATES = {"hypothesis", "open", "approved", "superseded", "rejected", "unknown"}
IMPLEMENTATION_STATES = {"absent", "partial", "implemented", "divergent", "unknown"}
EVIDENCE_TYPES = {"human_decision", "document_claim", "code", "test", "runtime", "playtest", "data"}
APPROVAL_STATES = {"unknown", "claimed", "approved", "rejected", "revoked"}
ATTESTABLE = {"approved", "rejected", "revoked"}
REF_RE = re.compile(r"^(?P<path>.+?)(?:#L(?P<start>\d+)(?:-L?(?P<end>\d+))?)?$")
STOP_WORDS = {"a", "an", "and", "are", "as", "at", "by", "for", "from", "how", "is", "it", "of", "on", "or", "the", "to", "what", "which", "with", "qual", "quais", "que", "como", "e", "de", "da", "do", "dos", "das", "em", "no", "na", "os", "as", "um", "uma", "para", "por", "sobre"}
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def normalized_words(value: str) -> set[str]:
    plain = unicodedata.normalize("NFKD", value.casefold())
    plain = "".join(c for c in plain if not unicodedata.combining(c))
    return {w for w in re.findall(r"[a-z0-9_]+", plain) if w not in STOP_WORDS and len(w) > 1}


def parse_record(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    start = text.find("<!-- dk-record\n")
    end = text.find("\n-->", start)
    if start != 0 or end < 0:
        raise ValueError(f"{path.name}: missing dk-record JSON header")
    record = json.loads(text[len("<!-- dk-record\n"):end])
    record["_path"] = path
    return record


def load_records() -> list[dict]:
    return [parse_record(p) for p in sorted(RECORDS.glob("*.md"))]


def current_csv() -> Path:
    csv_env = os.environ.get("PNMG_ECO_CSV", "").strip()
    if csv_env:
        return Path(csv_env).resolve()
    relative = Path("docs") / "economia_v2" / "tabela_economica_v2.csv"
    candidates = [ROOT.parent / relative]
    common = git("rev-parse", "--path-format=absolute", "--git-common-dir")  # a task worktree sits beside the main checkout
    if common:
        candidates.append(Path(common).resolve().parent.parent / relative)
    return next((c.resolve() for c in candidates if c.is_file()), candidates[0].resolve())


def safe_path(reference: str) -> tuple[Path, int | None, int | None]:
    if reference.startswith("@economy_csv:"):
        return current_csv(), None, None
    match = REF_RE.fullmatch(reference)
    if not match:
        raise ValueError(f"invalid reference: {reference}")
    path = (ROOT / match.group("path")).resolve()
    if not path.is_relative_to(ROOT.resolve()):
        raise ValueError(f"reference leaves current Git worktree: {reference}")
    start = int(match.group("start")) if match.group("start") else None
    end = int(match.group("end") or match.group("start")) if start else None
    return path, start, end


def git(*args: str) -> str | None:
    try:
        return subprocess.check_output(["git", "-C", str(ROOT), *args], text=True, encoding="utf-8", errors="replace", stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def git_bytes(*args: str) -> bytes | None:
    try:
        return subprocess.check_output(["git", "-C", str(ROOT), *args], stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError):
        return None


def path_state(path: Path, branch: str | None) -> str:
    try:
        relative = path.resolve().relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        return "external"
    tracked = git("ls-files", "--error-unmatch", "--", relative)
    if tracked is None:
        return "local"
    status = git("status", "--porcelain", "--", relative)
    if status is None:
        return "unknown"
    if status:
        return "local"
    if branch == "dev/active":
        return "integrated"
    return "committed"


# ---- freshness: where did the cited text go? --------------------------------------------------------

def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _norm(lines: list[str]) -> list[str]:
    """Whitespace-insensitive units: blank lines and indentation are not evidence."""
    return [l.strip() for l in lines if l.strip()]


def _history_baseline(rel: str, expected: str) -> bytes | None:
    """Committed version of `rel` whose fingerprint equals the recorded one (LF or CRLF checkout)."""
    for commit in (git("log", "--format=%H", "-n", "80", "--", rel) or "").split():
        blob = git_bytes("show", f"{commit}:{rel}")
        if blob is None:
            continue
        for variant in (blob, blob.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")):
            if _sha(variant) == expected:
                return variant
    return None


def _renamed_to(rel: str) -> str | None:
    """Staged or working-tree renames first, then committed history."""
    for text in (git("diff", "HEAD", "-M", "--name-status") or "", git("log", "-M", "--diff-filter=R", "--name-status", "--format=", "-n", "500") or ""):
        for line in text.splitlines():
            parts = line.split("\t")
            if len(parts) == 3 and parts[0].startswith("R") and parts[1] == rel:
                return parts[2]
    return None


def _locate(path: Path, rel: str, first: int, last: int, expected: str) -> dict:
    baseline = _history_baseline(rel, expected)
    if baseline is None:
        return {"state": "STALE", "detail": "file changed and the recorded version is not in git history; cannot localize the cited lines"}
    block = _norm(baseline.decode("utf-8", errors="replace").splitlines()[first - 1:last])
    if not block:
        return {"state": "UNKNOWN", "detail": "cited block was blank in the recorded version"}
    current = path.read_text(encoding="utf-8", errors="replace").splitlines()
    indexed = [(i, l.strip()) for i, l in enumerate(current, 1) if l.strip()]
    texts = [t for _, t in indexed]
    hits = [k for k in range(len(texts) - len(block) + 1) if texts[k:k + len(block)] == block]
    if not hits:
        return {"state": "CHANGED", "detail": "the cited text no longer appears in the file"}
    if len(hits) > 1:
        return {"state": "AMBIGUOUS", "detail": f"the cited text appears {len(hits)} times", "candidates": [indexed[k][0] for k in hits]}
    start, end = indexed[hits[0]][0], indexed[hits[0] + len(block) - 1][0]
    if (start, end) == (first, last):
        return {"state": "CURRENT", "detail": "file edited elsewhere; cited lines unchanged", "lines": [start, end]}
    return {"state": "MOVED", "detail": f"cited text moved from L{first}-L{last} to L{start}-L{end}", "lines": [start, end]}


def evaluate_source(reference: str | None, expected: str | None) -> dict:
    """CURRENT | MOVED | CHANGED | AMBIGUOUS | STALE | GONE | UNKNOWN for one registered source."""
    if not reference or not expected:
        return {"state": "UNKNOWN", "detail": "no fingerprint registered"}
    try:
        path, first, last = safe_path(reference)
    except ValueError as e:
        return {"state": "UNKNOWN", "detail": str(e)}
    csv_ref = reference.startswith("@economy_csv:")
    try:
        rel = path.resolve().relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        rel = None
    renamed = None
    if not path.is_file() and rel and not csv_ref:
        renamed = _renamed_to(rel)
        if renamed and (ROOT / renamed).is_file():
            path = ROOT / renamed
    if not path.is_file():
        return {"state": "GONE", "detail": "source file is missing and no rename was found"}
    if _sha(path.read_bytes()) == expected:
        if renamed:
            return {"state": "MOVED", "detail": f"file renamed to {renamed}; content identical", "path": renamed}
        return {"state": "CURRENT", "detail": "fingerprint matches"}
    if first is None or csv_ref or rel is None:
        return {"state": "STALE", "detail": "file changed" + (f" (renamed to {renamed})" if renamed else "")}
    result = _locate(path, rel, first, last, expected)
    if renamed:
        result["path"] = renamed
        result["detail"] += f"; file renamed to {renamed}"
        if result["state"] == "CURRENT":
            result["state"] = "MOVED"
    return result


def evidence_report(record: dict) -> list[dict]:
    rows = [{"kind": "evidence", "ref": e.get("ref"), **evaluate_source(e.get("ref"), e.get("sha256"))} for e in record.get("evidence", [])]
    rows += [{"kind": "implementation", "ref": s.get("path"), **evaluate_source(s.get("path"), s.get("sha256"))} for s in record.get("implementation_sources", [])]
    return rows


def evidence_status(record: dict) -> str:
    """Aggregate. Missing beats stale beats unknown; moved or edited-elsewhere sources still count as current."""
    states = {r["state"] for r in evidence_report(record)}
    if not states:
        return "UNKNOWN"
    if "GONE" in states:
        return "MISSING"
    if states & {"CHANGED", "AMBIGUOUS", "STALE"}:
        return "STALE"
    return "UNKNOWN" if "UNKNOWN" in states else "CURRENT"


def live_implementation(record: dict) -> str:
    """Do not reuse a reviewed status when its code snapshot changed."""
    for source in record.get("implementation_sources", []):
        try:
            path, _, _ = safe_path(source["path"])
            if not path.is_file() or _sha(path.read_bytes()) != source["sha256"]:
                return "unknown"
        except (KeyError, ValueError):
            return "unknown"
    return record.get("implementation_state", "unknown")


# ---- approval: claims versus attestations -----------------------------------------------------------

def claim_hash(record: dict) -> str:
    return hashlib.sha256(record.get("claim", "").strip().encode("utf-8")).hexdigest()


def load_ledger(path: str | None) -> dict:
    """Attestations are written only by the JabutiStudio server. A repository file can never create one."""
    if not path or not Path(path).is_file():
        return {}
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return {a["decision_id"]: a for a in data.get("approvals", []) if isinstance(a, dict) and a.get("decision_id")}


def effective_approval(record: dict, ledger: dict) -> dict:
    entry = ledger.get(record.get("id"))
    if entry and entry.get("state") in ATTESTABLE:
        if entry.get("claim_sha256") == claim_hash(record):
            return {"state": entry["state"], "source": "attested_local", "trust": "attested_local", "channel": entry.get("channel"), "at": entry.get("at"), "quote": entry.get("quote")}
        return {"state": "claimed", "source": "attestation-lapsed", "detail": "the claim text changed after it was attested"}
    claimed = (record.get("approval_state") in ATTESTABLE or record.get("decision_state") in {"approved", "superseded", "rejected"}
               or any(e.get("type") == "human_decision" for e in record.get("evidence", [])))
    if claimed:
        return {"state": "claimed", "source": "repository-claim"}
    return {"state": "unknown", "source": "none"}


def has_human_evidence(record: dict, relation: str) -> bool:
    for item in record.get("evidence", []):
        ref = item.get("ref", "")
        match = REF_RE.fullmatch(ref)
        if (item.get("type") == "human_decision" and item.get("relation") == relation
                and item.get("approval_scope") and item.get("approved_rule")
                and re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", ""))
                and match and match.group("start")):
            return True
    return False


def source_line(reference: str) -> tuple[Path, str]:
    path, first, last = safe_path(reference)
    if not path.is_file():
        raise FileNotFoundError(reference)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if reference.startswith("@economy_csv:"):
        wanted_id = reference.partition(":")[2]
        with path.open(encoding="utf-8-sig", newline="") as f:
            rows = list(csv.DictReader(f, delimiter=";"))
        row = next((r for r in rows if r.get("id") == wanted_id), None)
        if row is None:
            raise FileNotFoundError(f"CSV row not found: {wanted_id}")
        line = next(i for i, raw in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1) if raw.startswith(wanted_id + ";"))
        return path, f"{path} (outside current Git root) sha256={digest}\n  line {line}: {row}"
    display = f"{path.relative_to(ROOT).as_posix()} sha256={digest}"
    if first is not None:
        lines = path.read_text(encoding="utf-8").splitlines()
        if first < 1 or last is None or last > len(lines):
            raise ValueError(f"line range does not exist: {reference}")
        display += "\n" + "\n".join(f"  L{i}: {lines[i-1]}" for i in range(first, last + 1))
    return path, display


def cited_excerpt(reference: str, lines: list[int] | None = None, limit: int = 12) -> list[dict]:
    """The text a decision cites, read from the checkout under review (at the moved position when known)."""
    try:
        path, first, last = safe_path(reference)
    except ValueError:
        return []
    if first is None or not path.is_file() or reference.startswith("@economy_csv:"):
        return []
    if lines:
        first, last = lines
    text = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return [{"line": i, "text": text[i - 1]} for i in range(max(first, 1), min(last, len(text), first + limit - 1) + 1)]


# ---- validation: schema errors block, drifting references only warn ---------------------------------

def check(records: list[dict], selected_ids: set[str] | None = None, ledger: dict | None = None) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    ledger = ledger or {}
    by_id = {r.get("id"): r for r in records}
    required = {"id", "title", "claim", "decision_state", "approval_state", "implementation_state", "implementation_sources", "scope", "evidence", "supersedes", "conflicts_with", "files", "tests", "qps", "tags"}
    seen: set[str] = set()
    for r in records:
        label = str(r.get("id", r["_path"].name))
        if label in seen:
            errors.append(f"{label}: duplicate id")
        seen.add(label)
        missing = required - r.keys()
        if missing:
            errors.append(f"{label}: missing fields {', '.join(sorted(missing))}")
        if r.get("decision_state") not in DECISION_STATES:
            errors.append(f"{label}: invalid decision_state")
        if r.get("approval_state") not in APPROVAL_STATES:
            errors.append(f"{label}: invalid approval_state")
        if r.get("decision_state") == "approved" and r.get("approval_state") != "approved":
            errors.append(f"{label}: approved decision requires approval_state=approved")
        approval_relation = {"approved": "approves", "rejected": "rejects", "revoked": "revokes"}.get(r.get("approval_state"))
        if approval_relation and not has_human_evidence(r, approval_relation):
            errors.append(f"{label}: approval_state={r.get('approval_state')} requires line-scoped, fingerprinted human_decision evidence with scope, approved_rule, and relation={approval_relation}")
        if r.get("decision_state") == "superseded" and (not r.get("supersedes") or not has_human_evidence(r, "supersedes")):
            errors.append(f"{label}: superseded requires related decision IDs and line-scoped human supersession evidence")
        asserts = r.get("approval_state") in ATTESTABLE or r.get("decision_state") in {"approved", "superseded", "rejected"}
        if asserts and effective_approval(r, ledger)["state"] not in ATTESTABLE:
            errors.append(f"{label}: approval cannot be asserted by a repository file; it needs a ledger attestation bound to the current claim text (use state 'claimed' evidence until a human approves it in JabutiStudio)")
        if r.get("implementation_state") not in IMPLEMENTATION_STATES:
            errors.append(f"{label}: invalid implementation_state")
        for source in r.get("implementation_sources", []):
            try:
                safe_path(source["path"])
                if not re.fullmatch(r"[0-9a-f]{64}", source["sha256"]):
                    errors.append(f"{label}: invalid implementation snapshot {source}")
            except (KeyError, ValueError) as e:
                errors.append(f"{label}: invalid implementation snapshot: {e}")
        for relation in r.get("supersedes", []) + r.get("conflicts_with", []):
            if relation not in by_id:
                errors.append(f"{label}: unknown related decision {relation}")
        if selected_ids is not None and r.get("id") not in selected_ids:
            continue
        for evidence in r.get("evidence", []):
            if evidence.get("type") not in EVIDENCE_TYPES:
                errors.append(f"{label}: invalid evidence type {evidence.get('type')}")
            if evidence.get("sha256") and not re.fullmatch(r"[0-9a-f]{64}", evidence["sha256"]):
                errors.append(f"{label}: invalid evidence sha256 {evidence.get('ref')}")
            try:
                safe_path(evidence["ref"])
            except (KeyError, ValueError) as e:
                errors.append(f"{label}: invalid evidence ref: {e}")
        for row in evidence_report(r):
            if row["state"] in {"GONE", "CHANGED", "AMBIGUOUS"}:
                warnings.append(f"{label}: {row['kind']} {row['ref']} is {row['state']}: {row['detail']}")
        for item in r.get("files", []) + r.get("tests", []) + r.get("qps", []):
            try:
                p, _, _ = safe_path(item["path"] if isinstance(item, dict) else item)
                if not p.exists():
                    warnings.append(f"{label}: impact path no longer exists {item}")
            except (KeyError, ValueError) as e:
                errors.append(f"{label}: invalid impact path: {e}")
    for r in records:
        for other in r.get("conflicts_with", []):
            if other in by_id and r["id"] not in by_id[other].get("conflicts_with", []):
                errors.append(f"{r['id']}: conflict with {other} is not reciprocal")
    return errors, warnings


def validate(records: list[dict], selected_ids: set[str] | None = None, ledger: dict | None = None) -> list[str]:
    return check(records, selected_ids, ledger)[0]


# ---- retrieval --------------------------------------------------------------------------------------

def matching_records(records: list[dict], query: str) -> list[dict]:
    terms = normalized_words(query)
    hits = []
    for r in records:
        searchable = " ".join([r["id"], r["title"], r["claim"], *r["scope"], *r["tags"], str(r.get("system", ""))])
        overlap = terms & normalized_words(searchable)
        if overlap and len(overlap) >= min(2, len(terms)):
            hits.append(r)
    return _with_links(records, hits)


def _with_links(records: list[dict], hits: list[dict]) -> list[dict]:
    by_id = {r["id"]: r for r in records}
    included = {r["id"] for r in hits}
    for r in list(hits):
        included.update(x for x in r["conflicts_with"] + r["supersedes"] if x in by_id)
    return [r for r in records if r["id"] in included]


def records_for_file(records: list[dict], rel: str) -> list[tuple[dict, list[str]]]:
    """Decisions that cite or list this file, with how. Exact path match; lines are not required."""
    rel = rel.replace("\\", "/").lstrip("./")
    out = []
    for r in records:
        how: list[str] = []
        for e in r.get("evidence", []):
            m = REF_RE.fullmatch(e.get("ref", ""))
            if m and m.group("path") == rel and not e.get("note", "").startswith("CANDIDATE IMPACT ONLY:"):
                how.append(f"evidence:{e.get('type')}" + (f"#L{m.group('start')}" if m.group("start") else ""))
        for s in r.get("implementation_sources", []):
            if s.get("path") == rel:
                how.append("implementation")
        for key in ("files", "tests", "qps"):
            for item in r.get(key, []):
                if (item["path"] if isinstance(item, dict) else item) == rel:
                    how.append(f"impact:{key}(candidate)")
        if how:
            out.append((r, how))
    return out


def describe(record: dict, ledger: dict, branch: str | None, full: bool = True) -> dict:
    rows = evidence_report(record)
    by_ref = {(row["kind"], row["ref"]): row for row in rows}
    cited = {REF_RE.fullmatch(e["ref"]).group("path") for e in record["evidence"]
             if REF_RE.fullmatch(e["ref"]) and not e.get("note", "").startswith("CANDIDATE IMPACT ONLY:")}
    evidence = []
    for e in record["evidence"]:
        fresh = by_ref.get(("evidence", e.get("ref")), {"state": "UNKNOWN", "detail": ""})
        evidence.append({
            "type": e.get("type"), "ref": e.get("ref"), "note": e.get("note", ""),
            "candidate_only": e.get("note", "").startswith("CANDIDATE IMPACT ONLY:"),
            "freshness": fresh["state"], "detail": fresh.get("detail", ""), "lines": fresh.get("lines"), "path": fresh.get("path"),
            "excerpt": cited_excerpt(e["ref"], fresh.get("lines")) if full and fresh["state"] in {"CURRENT", "MOVED"} else [],
        })
    return {
        "id": record["id"], "title": record["title"], "claim": record["claim"], "claim_sha256": claim_hash(record), "system": record.get("system"),
        "scope": record["scope"], "decision_state": record["decision_state"],
        "approval": effective_approval(record, ledger),
        "evidence_status": evidence_status(record), "implementation": live_implementation(record),
        "catalogued_implementation": record["implementation_state"],
        "supersedes": record["supersedes"], "conflicts_with": record["conflicts_with"],
        "record_integration": path_state(record["_path"], branch),
        "files": [{"role": f["role"], "path": f["path"]} for f in record["files"]],
        "tests": [{"path": t, "direct": t in cited} for t in record["tests"]],
        "qps": [{"path": q, "direct": q in cited} for q in record["qps"]],
        "evidence": evidence,
    }


def context(records: list[dict], selected: list[dict], ledger: dict, matched_by: dict | None = None) -> dict:
    branch = git("branch", "--show-current")
    return {
        "root": str(ROOT), "branch": branch or None, "head": git("rev-parse", "--short", "HEAD"),
        "records_root": str(RECORDS), "indexed": bool(selected),
        "decisions": [{**describe(r, ledger, branch), **({"matched_by": matched_by[r["id"]]} if matched_by and r["id"] in matched_by else {})} for r in selected],
        "note": None if selected else "NOT_INDEXED: no decision record matched; this does not establish that no decision exists.",
    }


def print_text(ctx: dict) -> None:
    print(f"WORKTREE={ctx['root']}\nBRANCH={ctx['branch'] or 'unknown'} HEAD={ctx['head'] or 'unknown'}")
    if not ctx["decisions"]:
        print(ctx["note"])
        return
    total = evidence_chars = 0
    for d in ctx["decisions"]:
        print(f"\n## {d['id']} — {d['title']}")
        a = d["approval"]
        print(f"decision={d['decision_state']} approval={a['state']} approval_source={a['source']} evidence={d['evidence_status']} implementation={d['implementation']} catalogued_implementation={d['catalogued_implementation']} record_integration={d['record_integration']}")
        print(f"claim: {d['claim']}\nscope: {', '.join(d['scope'])}")
        if d["supersedes"]:
            print("supersedes: " + ", ".join(d["supersedes"]))
        if d["conflicts_with"]:
            print("UNRESOLVED_CONTRADICTION: " + ", ".join(d["conflicts_with"]))
        print("affected files (candidates):")
        for item in d["files"]:
            print(f"  - {item['role']}: {item['path']}")
        for title, key in (("tests", "tests"), ("QPs", "qps")):
            print(title + " (direct if cited above; otherwise candidate impact):")
            for item in d[key]:
                print(f"  - {'direct' if item['direct'] else 'inferred'}: {item['path']}")
        print("evidence (checkout under review):")
        for e in d["evidence"]:
            if e["candidate_only"]:
                continue
            lines = "\n".join(f"      L{x['line']}: {x['text']}" for x in e["excerpt"])
            print(f"  [{e['type']}; {e['freshness']}] {e['note']}\n    {e['ref']} — {e['detail']}" + (f"\n{lines}" if lines else ""))
            evidence_chars += len(lines)
        total += len(json.dumps(d, ensure_ascii=False))
    print(f"\nRETRIEVAL records={len(ctx['decisions'])} metadata_chars={total} evidence_chars={evidence_chars} context_tokens=NOT_MEASURED")


def query(query_text: str, records: list[dict], ledger: dict | None = None, as_json: bool = False) -> int:
    ledger = ledger or {}
    selected = matching_records(records, query_text)
    errors = validate(records, {r["id"] for r in selected}, ledger) if selected else []
    if errors:
        print("Selected record validation failed:\n" + "\n".join(errors), file=sys.stderr)
        return 1
    ctx = context(records, selected, ledger)
    if as_json:
        print(json.dumps(ctx, ensure_ascii=False))
    else:
        print_text(ctx)
    return 0


def for_file(path: str, records: list[dict], ledger: dict, as_json: bool) -> int:
    pairs = records_for_file(records, path)
    selected = _with_links(records, [r for r, _ in pairs])
    ctx = context(records, selected, ledger, {r["id"]: how for r, how in pairs})
    ctx["file"] = path
    if as_json:
        print(json.dumps(ctx, ensure_ascii=False))
    else:
        print_text(ctx)
    return 0


def provenance(resource: str) -> int:
    try:
        target, _, _ = safe_path(resource)
    except ValueError as e:
        print(f"invalid resource reference: {e}", file=sys.stderr)
        return 2
    generator = ROOT / "tools" / "perks" / "gerar_perks_v5.gd"
    csv_path = current_csv()
    print(f"WORKTREE={ROOT}\nRESOURCE={target}\nGENERATOR={generator}\nCSV={csv_path}")
    for label, path in (("generator", generator), ("resource", target), ("csv", csv_path)):
        if path.is_file():
            outside = not path.resolve().is_relative_to(ROOT.resolve())
            print(f"{label}_sha256={hashlib.sha256(path.read_bytes()).hexdigest()} outside_git_root={outside}")
        else:
            print(f"{label}=MISSING")
    if not target.is_file() or not csv_path.is_file():
        print("sync=UNKNOWN; source or generated resource is unavailable; no generation attempted")
        return 2
    with csv_path.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f, delimiter=";"))
    row = next((r for r in rows if r.get("id") == target.stem), None)
    if row is None:
        print("sync=UNKNOWN; resource id not present in CSV; no generation attempted")
        return 2
    text = target.read_text(encoding="utf-8")
    expected = {"title": row["nome"], "base_cost": row["preco_por_nivel"], "description": row["efeito"], "axial_position": f"Vector2i({row['q']}, {row['r']})"}
    actual = {}
    for key in expected:
        match = re.search(rf"^{re.escape(key)}\s*=\s*(.+)$", text, re.MULTILINE)
        actual[key] = match.group(1).strip().strip('"') if match else "MISSING"
    for key in expected:
        print(f"field_{key}: expected={expected[key]!r} actual={actual[key]!r} match={expected[key] == actual[key]}")
    print(f"csv_old_cost={row.get('custo_antigo_seiva', '')!r} csv_status={row.get('status', '')!r}")
    print("sync=FIELDS_MATCH" if expected == actual else "sync=DIVERGENT")
    print("mutation=NONE; the generator was inspected but never invoked")
    return 0


def main() -> int:
    global ROOT, RECORDS
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--root", help="checkout whose files are examined as evidence (default: this repository)")
    common.add_argument("--records", help="directory with the canonical decision records (default: <repo>/docs/design_knowledge/records)")
    common.add_argument("--approvals", default=os.environ.get("DK_APPROVALS"), help="attestation ledger written by JabutiStudio")
    common.add_argument("--json", action="store_true", help="machine-readable output")
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("validate", parents=[common], help="validate record schema; drifting references are warnings")
    q = sub.add_parser("query", parents=[common], help="retrieve matching decisions and explicit contradictions")
    q.add_argument("text")
    f = sub.add_parser("file", parents=[common], help="decisions that cite or list a file (path relative to --root)")
    f.add_argument("path")
    p = sub.add_parser("provenance", parents=[common], help="read-only CSV/resource provenance check")
    p.add_argument("resource", nargs="?", default="perks_v5/spore_source.tres")
    args = parser.parse_args()
    if args.root:
        ROOT = Path(args.root).resolve()
        RECORDS = ROOT / "docs" / "design_knowledge" / "records"
    if args.records:
        RECORDS = Path(args.records).resolve()
    try:
        records = load_records()
    except (OSError, ValueError, json.JSONDecodeError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    ledger = load_ledger(args.approvals)
    if args.command == "validate":
        errors, warnings = check(records, None, ledger)
        unresolved = sorted({tuple(sorted((r["id"], x))) for r in records for x in r["conflicts_with"]})
        statuses = {name: sum(evidence_status(r) == name for r in records) for name in ("CURRENT", "STALE", "MISSING", "UNKNOWN")}
        if args.json:
            print(json.dumps({"valid": not errors, "records": len(records), "errors": errors, "warnings": warnings,
                              "unresolved_conflicts": [list(x) for x in unresolved], "evidence_statuses": statuses}, ensure_ascii=False))
            return 1 if errors else 0
        if errors:
            print("\n".join(errors))
            return 1
        print(f"VALID records={len(records)} unresolved_conflicts={len(unresolved)} warnings={len(warnings)} evidence_statuses={statuses}")
        for w in warnings:
            print("WARNING " + w)
        for pair in unresolved:
            print("UNRESOLVED_CONTRADICTION=" + " <-> ".join(pair))
        return 0
    if args.command == "query":
        return query(args.text, records, ledger, args.json)
    if args.command == "file":
        return for_file(args.path, records, ledger, args.json)
    return provenance(args.resource)


if __name__ == "__main__":
    raise SystemExit(main())
