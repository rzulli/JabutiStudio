extends Node
class_name Player

@export var speed: float = 3.5
signal moved(pos)

func _ready() -> void:
	# tabs must survive
	print("hi %s" % name)
