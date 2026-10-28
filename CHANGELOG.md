# Changelog

## 0.3 (2026-10-27)

- Conveyor discharge feed added: belt speed, direction, drop below the head pulley, stream width, release scatter and forward spin. Stones now hit the funnel or the first bucket wall in the moonpool and enter the water tumbling.
- Vessel motion added: regular roll, pitch and heave with random phases per run, applied as apparent gravity in the pipe frame (gravity tilt, acceleration of the pipe at depth below the roll centre, heave acceleration).
- Numerical precision presets added (Standard, High, Very high). High is the default: overlap at most 1 % of Dn50 at the terminal velocity of Dn90, time step at most 0.10 of the contact time.
- New outputs:
  - wall impacts per bucket (count, energy, peak normal speed)
  - stone speed and long-axis angle at the water surface
- Probability tab added: headless runs in Web Workers, grade against parameter matrix, Wilson intervals, Poisson blockage rate per 1000 t, run table with Replay in Simulate.
- 3D validation benchmark added: silo clogging with identical spheres at D/d 3, 4 and 6 against Zuriguel et al. (2005).

## 0.2 (2026-10-27)

- Fixed a false blockage caused by the contact model. Block stones had spheres at the corners of the full L x B x T box, which made them up to 40 % wider across the diagonal than L. Stones smaller than the opening wedged across the bucket lips.
- Stone body changed to a superellipsoid in L x B x T, with the exponent set by the volume factor (p = 2.33 at 0.6). All contact spheres are inscribed in the body. The drawn stone is the same body.
- Inertia now computed from the superellipsoid.
- Dome card shows L x B x T of a jammed single stone against the passage.
- At 4000 t/h with 800 mm bucket bottoms, blocked runs fell from 6 of 6 seeds to 1 of 6. The one remaining blockage is a genuine multi-stone dome.

## 0.1 (2026-10-27)

- First 3D version, built from the 2D app: 6-degree-of-freedom sphere clumps, revolved bucket walls, shared 1D water column, 12-sector dome detection, WebGL view.
- Time step from the rotational effective mass, so that settled packs come to rest.
