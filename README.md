# Pukeko Robot Controller Project

## Concept

AI-driven control of an Acebott biped robot via the Pukeko web UI and `@gaunt-sloth/api` backend.

A webcam is mounted above a table, pointing down at the robot. The user issues high-level goals
(e.g. "move the robot to the center of the table") and the LLM agent iterates autonomously:
observe (capture a camera frame), reason about the robot's position, act (issue locomotion commands
and/or read the ultrasonic sensor), then repeat until the goal is met.