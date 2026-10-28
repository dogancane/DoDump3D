# Validation status and input data

DoDump 3D lab 0.3. This page lists what has been checked, what rests on literature, and what is still an assumption. Read it before using results outside relative comparisons.

## 1. Verified (implementation and numerics)

| Check | Result |
|---|---|
| Single sphere in still water | Reaches the Newton-drag terminal velocity: 3.065 m/s simulated against 3.065 m/s analytic, no lateral drift |
| 40 stones settling on the closed restart gate | Kinetic energy from about 250 J to below 0.001 J; highest speed 3 mm/s; overlap about 1 % of stone radius. Also stable with restitution 0.1 |
| Mass and count balance | Residual 0 in every run |
| Stones escaping through walls | None in the test runs |
| Contact sphere fill | All spheres inside the stone body; reaches on average 97 to 99 % of each half axis (worst 92 %); diagonal width at most 1.045 L |
| Engine against published 3D clogging (silo, identical spheres) | D/d = 3: every run jammed after 4 to 70 grains. D/d = 4 and 6: silo emptied without a loaded arch. Matches the trend in Zuriguel et al. (2005), which observed no jams above about 4.9 for spheres |

The benchmark can be rerun from the Probability tab ("Run benchmark").

## 2. Based on literature, not calibrated for this system

| Item | Basis |
|---|---|
| Normal and tangential contact, Coulomb friction | Cundall and Strack (1979), standard DEM practice |
| Rolling resistance | Constant directional torque, one of the model families compared by Ai et al. (2011) |
| Restitution under water | Joseph et al. (2001): wet restitution depends on the Stokes number and approaches the dry value above St of about 1000. Rock impacts here have St of about 10^4 to 10^5, so dry restitution applies |
| Hindered drag | Di Felice (1994) voidage function; Richardson and Zaki exponent from Miedema |
| Water column hydraulics | Haaland friction factor, Borda-Carnot expansion loss, orifice law at joint gaps |
| Rock shape statistics | Zingg classes; Rock Manual (CIRIA/CUR/CETMEF 2007) 3.4.1.6 for L/T > 3 shares; Domokos et al. (2020) for the cube-like average fragment |
| Rock-wall friction, HDPE | Interface shear tests of granular soil on smooth HDPE geomembranes report friction angles of roughly 15 to 25 deg (mu about 0.27 to 0.47). Default 0.3 lies in this range |

## 3. Assumptions without data for this system

Replace these with measured values where possible. The Probability tab can vary the most important ones as a sensitivity check.

| Input | Default | What would fix it |
|---|---|---|
| Rock-HDPE friction, wet | 0.30 | Tilting-plate or shear-box test, wet quarried rock on a bucket wall offcut |
| Rock-rock friction | 0.60 | Tilt test on the grade |
| Restitution rock-rock, rock-wall | 0.30, 0.25 | Drop tests, or literature for the rock type |
| Rolling resistance | 0.05 | Calibration against an angle-of-repose test |
| Block volume factor V/(L B T) | 0.60 | Measured L, B, T and mass of the batch |
| Shape class mix | 55/15/15/10/5 % | Shape counts of the actual grade |
| Contact stiffness | Softened (overlap 1 % at the terminal velocity of Dn90) | Compare Standard, High and Very high on the key case |
| Dome test, stall speed, persistence time | 12 sectors, 0.05 m/s, 2 s | Engineering judgement; editable |

## 4. Not modelled

- Dynamic response of the bucket string to waves and current (only the static shape is solved)
- Water sloshing in the pipe and air entrainment at the moonpool
- Wakes, clustering and the radial water velocity profile (needs CFD-DEM)
- Rock breakage and abrasion
- Sharp edges finer than the superellipsoid exponent

## 5. How to use results

- **Use for:** relative comparisons with the same seeds, duration and precision. For example pipe bottom ID 900 against 1100 mm, grade A against grade B, conveyor direction, roll amplitude.
- **Number of runs:** 50 to 100 seeds per cell usually separates two designs. To pin down a 5 % probability to about plus or minus 2 points, about 450 runs per cell are needed.
- **Check the numerics:** before relying on a difference, rerun the key cell at Very high precision and with rock-wall friction at 0.2 and 0.45.
- **Do not use for:** absolute blockage frequency in operation, until the inputs in section 3 are measured and the model has been compared with field or scale-test blockage data for a known pipe and grade.

## References

- Ai, J., Chen, J.-F., Rotter, J.M., Ooi, J.Y. (2011). Assessment of rolling resistance models in discrete element simulations. Powder Technology 206, 269-282.
- CIRIA, CUR, CETMEF (2007). The Rock Manual. C683.
- Cundall, P.A., Strack, O.D.L. (1979). A discrete numerical model for granular assemblies. Geotechnique 29, 47-65.
- Di Felice, R. (1994). The voidage function for fluid-particle interaction systems. Int. J. Multiphase Flow 20, 153-159.
- Domokos, G., Jerolmack, D.J., Kun, F., Torok, J. (2020). Plato's cube and the natural geometry of fragmentation. PNAS 117, 18178-18185.
- Janda, A., Zuriguel, I., Maza, D. et al. (2015). Clogging of granular materials in narrow vertical pipes discharged at constant velocity. Granular Matter 17, 545-551.
- Joseph, G.G., Zenit, R., Hunt, M.L., Rosenwinkel, A.M. (2001). Particle-wall collisions in a viscous fluid. J. Fluid Mech. 433, 329-346.
- Thomas, C.C., Durian, D.J. (2015). Fraction of clogging configurations sampled by granular hopper flow. Phys. Rev. Lett. 114, 178001.
- Zuriguel, I., Garcimartin, A., Maza, D., Pugnaloni, L.A., Pastor, J.M. (2005). Jamming during the discharge of granular matter from a silo. Phys. Rev. E 71, 051303.
