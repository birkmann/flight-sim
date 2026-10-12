//! The flight path guide, for beginners: the route drawn in the air as a row of gates to fly through. It follows the
//! plan's legs, turning at each waypoint on the arc the flight management would fly, and a vertical path: up the climb,
//! level at cruise, down the descent path and the glide slope to the runway. The next gate turns green while the
//! aircraft is inside the tunnel. Switched on in the planner, with the cockpit strip's GUIDE button or J; the
//! aircraft's distance from the path goes to the cockpit as the HUD's `guide`.

use std::f64::consts::{FRAC_PI_2, PI};

use bevy::asset::RenderAssetUsages;
use bevy::light::{NotShadowCaster, NotShadowReceiver};
use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::prelude::*;
use serde_json::json;

use super::nav::{self, FT_PER_NM, LatLon, NM, Route};
use super::types::{FT, KT, Type};
use super::{Aircraft, HudOut, Phase, Session, airport};
use crate::origin::Frame;
use crate::sandbox::NoHit;

/// Gates shown ahead of the aircraft.
const GATES: usize = 16;

/// Whether the guide shows. It outlasts a flight; the planner sets it for each new one.
#[derive(Resource, Default)]
pub struct Guide {
    pub on: bool,
    gates: Vec<Entity>,
    /// The aircraft the gates were made for (their size is its type's).
    made_for: Option<Entity>,
    /// The gates', the next gate's, and the next gate's while the aircraft is inside the tunnel.
    materials: Option<[Handle<StandardMaterial>; 3]>,
}

#[derive(Component)]
pub struct Gate;

/// Where the guide's climb begins: from an altitude (ft), this far along the route (m: past the take-off run), up to
/// a level (ft: the cruise, or after a go-around the approach altitude).
#[derive(Clone, Copy, Default)]
pub struct Climb {
    pub from_ft: f64,
    pub at_m: f64,
    pub top_ft: f64,
}

/// For a type: the gates' spacing and size (m), the climb's initial gradient (ft per NM, flattening toward a ceiling
/// a quarter above the type's), the speed its turns are drawn for (kt, on a 25° bank), and its take-off run (m).
pub struct Style {
    spacing: f64,
    w: f32,
    h: f32,
    climb: f64,
    turn_kt: f64,
    pub roll: f64,
}

pub fn style(ty: &Type) -> Style {
    match ty.panel {
        "ga" => Style { spacing: 250.0, w: 50.0, h: 34.0, climb: 450.0, turn_kt: 95.0, roll: 350.0 },
        "fighter" => Style { spacing: 700.0, w: 100.0, h: 66.0, climb: 1_000.0, turn_kt: 320.0, roll: 900.0 },
        _ => Style { spacing: 600.0, w: 120.0, h: 80.0, climb: 600.0, turn_kt: 220.0, roll: 1_500.0 },
    }
}

enum Seg {
    Line { from: LatLon, to: LatLon },
    /// A turn of radius `r` (m) about a centre, starting at a bearing from it (rad), clockwise for `sign` 1.
    Arc { centre: LatLon, r: f64, from_brg: f64, sign: f64 },
}

struct Piece {
    seg: Seg,
    len: f64,
    /// Metres along the path at its start, and the route leg it belongs to (index of the waypoint it leads to).
    start: f64,
    leg: usize,
}

/// The route as a path to fly: its legs joined by turns that fly by each waypoint.
struct Path {
    pieces: Vec<Piece>,
    len: f64,
}

impl Path {
    fn new(route: &Route, radius: f64) -> Option<Path> {
        let w = &route.wpts;
        if w.len() < 2 {
            return None;
        }
        let mut path = Path { pieces: Vec::new(), len: 0.0 };
        let push = |path: &mut Path, seg: Seg, len: f64, leg: usize| {
            path.pieces.push(Piece { seg, len, start: path.len, leg });
            path.len += len;
        };
        let mut from = w[0].pos;
        for i in 1..w.len() {
            let b = w[i].pos;
            // The turn onto the next leg: it starts `lead` before the waypoint, at most half the next leg (the turn
            // after it needs room too) and all of what is left of this one.
            let turn = w.get(i + 1).and_then(|next| {
                let crs_in = (nav::bearing(b, from) + PI).rem_euclid(std::f64::consts::TAU);
                let crs_out = nav::bearing(b, next.pos);
                let delta = nav::wrap(crs_out - crs_in);
                // Nothing to turn, or all but a reversal (flown as a corner).
                let half = delta.abs() / 2.0;
                if !(0.01..1.5).contains(&half) {
                    return None;
                }
                let lead = (radius * half.tan()).min(nav::distance(from, b)).min(nav::distance(b, next.pos) * 0.5);
                let r = lead / half.tan();
                let sign = delta.signum();
                let entry = nav::destination(b, crs_in + PI, lead);
                let exit = nav::destination(b, crs_out, lead);
                let centre = nav::destination(entry, crs_in + sign * FRAC_PI_2, r);
                Some((entry, exit, Seg::Arc { centre, r, from_brg: crs_in - sign * FRAC_PI_2, sign }, r * delta.abs()))
            });
            let end = turn.as_ref().map_or(b, |t| t.0);
            push(&mut path, Seg::Line { from, to: end }, nav::distance(from, end), i);
            from = b;
            if let Some((_, exit, arc, len)) = turn {
                push(&mut path, arc, len, i);
                from = exit;
            }
        }
        Some(path)
    }

    /// The point `s` metres along, and the track there (rad).
    fn at(&self, s: f64) -> (LatLon, f64) {
        let i = self.pieces.partition_point(|p| p.start + p.len < s).min(self.pieces.len() - 1);
        let p = &self.pieces[i];
        let t = (s - p.start).clamp(0.0, p.len);
        match p.seg {
            Seg::Line { from, to } => {
                let q = nav::destination(from, nav::bearing(from, to), t);
                (q, if p.len - t > 1.0 { nav::bearing(q, to) } else { nav::bearing(to, from) + PI })
            }
            Seg::Arc { centre, r, from_brg, sign } => {
                let th = from_brg + sign * t / r;
                (nav::destination(centre, th, r), th + sign * FRAC_PI_2)
            }
        }
    }

    /// Where `p` is against the path, looking at the pieces around the route's active leg: metres along it, and
    /// metres right of it (negative left).
    fn locate(&self, p: LatLon, leg: usize) -> (f64, f64) {
        self.pieces
            .iter()
            .filter(|q| q.leg + 1 >= leg && q.leg <= leg + 1)
            .map(|q| {
                let (t, xtk) = match q.seg {
                    Seg::Line { from, to } => {
                        let (xtk, along) = nav::cross_track(from, to, p);
                        (along.clamp(0.0, q.len), xtk)
                    }
                    Seg::Arc { centre, r, from_brg, sign } => {
                        let th = (nav::wrap(nav::bearing(centre, p) - from_brg) * sign).clamp(0.0, q.len / r);
                        (th * r, (r - nav::distance(centre, p)) * sign)
                    }
                };
                // Off the end of a piece, the distance to its end counts too.
                let (near, _) = self.at(q.start + t);
                (q.start + t, xtk, nav::distance(near, p))
            })
            .min_by(|a, b| a.2.total_cmp(&b.2))
            .map_or((0.0, 0.0), |(s, xtk, _)| (s, xtk))
    }

    /// The guide's altitude (ft) `s` metres along: the climb (flattening with height) up to its level, and never above
    /// the descent path or the 3° glide slope to the runway at `arr_ft`.
    fn alt_ft(&self, s: f64, route: &Route, climb: &Climb, style: &Style, ty: &Type, arr_ft: Option<f64>) -> f64 {
        let ceiling = f64::from(ty.ceiling) * 1.25;
        let run = (s - climb.at_m).max(0.0) / NM;
        let up = (climb.from_ft + ceiling * (1.0 - (-style.climb * run / ceiling).exp())).min(climb.top_ft);
        let Some(elev) = arr_ft else { return up };
        let dtg = (self.len - s).max(0.0);
        up.min(route.path_ft(dtg, elev)).min(elev + 50.0 + dtg / NM * FT_PER_NM)
    }
}

/// A gate: a flat rectangular frame, across the path.
fn gate_mesh(w: f32, h: f32) -> Mesh {
    let (x, y) = (w / 2.0, h / 2.0);
    let b = h * 0.06;
    let (ix, iy) = (x - b, y - b);
    let positions = vec![[-x, -y, 0.0], [x, -y, 0.0], [x, y, 0.0], [-x, y, 0.0], [-ix, -iy, 0.0], [ix, -iy, 0.0], [ix, iy, 0.0], [-ix, iy, 0.0]];
    // Each side a quad between the outer and the inner rectangle.
    let mut indices = Vec::with_capacity(24);
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        indices.extend_from_slice(&[k, n, 4 + n, k, 4 + n, 4 + k]);
    }
    Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::RENDER_WORLD)
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, positions)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0, 0.0, 1.0]; 8])
        .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, vec![[0.0, 0.0]; 8])
        .with_inserted_indices(Indices::U32(indices))
}

/// The gates ahead of the flight's aircraft, placed in the current frame (after any rebase), and the aircraft's
/// distance from the path for the cockpit.
#[allow(clippy::too_many_arguments)]
pub fn place(
    mut commands: Commands,
    mut guide: ResMut<Guide>,
    s: Res<Session>,
    frame: Res<Frame>,
    mut hud: ResMut<HudOut>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    aircraft: Query<(&Transform, &Aircraft), Without<Gate>>,
    mut gates: Query<(&mut Transform, &mut Visibility, &mut MeshMaterial3d<StandardMaterial>), With<Gate>>,
) {
    let guide = &mut *guide;
    let st = style(s.ty);
    let flying = s.aircraft.filter(|_| guide.on && matches!(s.phase, Phase::Flying | Phase::Landed));
    if guide.made_for != flying {
        for e in guide.gates.drain(..) {
            commands.entity(e).try_despawn();
        }
        guide.made_for = flying;
        if flying.is_some() {
            let [far, next, _] = guide.materials.get_or_insert_with(|| {
                let mat = |c: Color| StandardMaterial { base_color: c, alpha_mode: AlphaMode::Blend, unlit: true, cull_mode: None, ..default() };
                [materials.add(mat(Color::srgba(1.0, 0.42, 1.0, 0.55))), materials.add(mat(Color::srgba(1.0, 0.42, 1.0, 0.95))), materials.add(mat(Color::srgba(0.24, 1.0, 0.43, 0.95)))]
            });
            let (far, next) = (far.clone(), next.clone());
            let mesh = meshes.add(gate_mesh(st.w, st.h));
            for i in 0..GATES {
                let mat = if i == 0 { next.clone() } else { far.clone() };
                let e = commands.spawn((Gate, Mesh3d(mesh.clone()), MeshMaterial3d(mat), Transform::default(), Visibility::Hidden, NoHit, NotShadowCaster, NotShadowReceiver)).id();
                guide.gates.push(e);
            }
        }
    }
    let Some((tf, ac)) = flying.and_then(|e| aircraft.get(e).ok()) else { return };
    let Some(looks) = guide.materials.clone() else { return };
    let v = st.turn_kt / f64::from(KT);
    let Some(path) = Path::new(&s.route, v * v / (9.81 * 25f64.to_radians().tan())) else {
        for &g in &guide.gates {
            if let Ok((_, mut vis, _)) = gates.get_mut(g) {
                vis.set_if_neq(Visibility::Hidden);
            }
        }
        return;
    };
    let ft = f64::from(FT);
    let (lat, lon, _) = frame.geodetic(tf.translation);
    let (along, xtk) = path.locate((lat, lon), s.route.active);
    let arr_ft = s.arr.as_ref().map(|r| r.a.elev_ft);
    let dep_ft = s.dep.as_ref().map_or(0.0, |r| r.a.elev_ft);
    let profile = |d: f64| path.alt_ft(d, &s.route, &s.climb, &st, s.ty, arr_ft);
    let dev_ft = profile(along) - f64::from(frame.altitude(tf.translation)) * ft;
    let inside = !ac.on_ground && xtk.abs() < f64::from(st.w) / 2.0 && dev_ft.abs() / ft < f64::from(st.h) / 2.0;

    // Fixed stations along the path, so that the gates stand still; the first a little ahead of the aircraft. Near the
    // airports, none low enough to touch the ground.
    let first = ((along + st.spacing * 0.3) / st.spacing).ceil();
    let mut next = None;
    for (i, &g) in guide.gates.iter().enumerate() {
        let Ok((mut gtf, mut vis, mut mat)) = gates.get_mut(g) else { continue };
        let d = (first + i as f64) * st.spacing;
        let alt = profile(d);
        let ground = if d < path.len / 2.0 { dep_ft } else { arr_ft.unwrap_or(dep_ft) };
        let shown = d <= path.len && alt - ground > f64::from(st.h) / 2.0 * ft + 30.0;
        vis.set_if_neq(if shown { Visibility::Inherited } else { Visibility::Hidden });
        if !shown {
            continue;
        }
        let (p, trk) = path.at(d);
        let at = frame.from_ecef(airport::ecef(p, alt / ft));
        let ahead = frame.from_ecef(airport::ecef(nav::destination(p, trk, 100.0), alt / ft));
        let up = frame.from_ecef(airport::ecef(p, alt / ft + 100.0));
        *gtf = Transform::from_translation(at).looking_to(ahead - at, up - at);
        let want = if next.is_some() {
            &looks[0]
        } else {
            next = Some(d - along);
            if inside { &looks[2] } else { &looks[1] }
        };
        if mat.0 != *want {
            mat.0 = want.clone();
        }
    }
    if let Some(o) = hud.0.as_object_mut() {
        let airborne = !ac.on_ground;
        o.insert("guide".into(), json!({ "dev": airborne.then_some(dev_ft), "xtk": xtk, "inside": inside, "next": next }));
    }
}

#[cfg(test)]
mod tests {
    use super::super::nav::{Kind, Waypoint};
    use super::super::types::AIRLINER;
    use super::*;

    fn route() -> Route {
        let wp = |id: &str, pos: LatLon, kind: Kind| Waypoint { id: id.into(), pos, alt: None, kind };
        // East 3°, then a right turn south, 3° on to the runway: about 300 NM.
        Route {
            wpts: vec![wp("DEP", (50.0, 8.0), Kind::Departure), wp("A", (50.0, 11.0), Kind::Fix), wp("RW", (47.0, 11.0), Kind::Arrival)],
            cruise_ft: 20_000.0,
            ..Route::default()
        }
    }

    #[test]
    fn turns_join_the_legs() {
        let path = Path::new(&route(), 3_000.0).unwrap();
        assert_eq!(path.pieces.len(), 3);
        // Shorter than the legs: the turn cuts the corner.
        let legs = nav::distance((50.0, 8.0), (50.0, 11.0)) + nav::distance((50.0, 11.0), (47.0, 11.0));
        assert!(path.len < legs && path.len > legs - 2_000.0, "{} {legs}", path.len);
        // No jumps: points a metre apart along the path are a metre apart.
        let mut s = 0.0;
        while s < path.len - 1.0 {
            let jump = nav::distance(path.at(s).0, path.at(s + 1.0).0);
            assert!((jump - 1.0).abs() < 0.05, "at {s}: {jump}");
            s += 997.0;
        }
        // The track swings from east to south through the turn.
        let arc = &path.pieces[1];
        let (_, before) = path.at(arc.start);
        let (_, after) = path.at(arc.start + arc.len);
        assert!(nav::wrap(before - FRAC_PI_2).abs() < 0.02 && nav::wrap(after - PI).abs() < 0.02, "{before} {after}");
    }

    #[test]
    fn locates_a_point_along_and_beside() {
        let path = Path::new(&route(), 3_000.0).unwrap();
        for s in [5_000.0, path.pieces[1].start + 500.0, path.len - 10_000.0] {
            let (p, trk) = path.at(s);
            // 200 m left of the path there.
            let off = nav::destination(p, trk - FRAC_PI_2, 200.0);
            let leg = path.pieces.iter().rev().find(|q| q.start <= s).unwrap().leg;
            let (along, xtk) = path.locate(off, leg);
            assert!((along - s).abs() < 30.0, "{along} {s}");
            assert!((xtk + 200.0).abs() < 5.0, "{xtk}");
        }
    }

    #[test]
    fn climbs_levels_and_descends_to_the_runway() {
        let r = route();
        let path = Path::new(&r, 3_000.0).unwrap();
        let st = style(&AIRLINER);
        let climb = Climb { from_ft: 300.0, at_m: st.roll, top_ft: r.cruise_ft };
        let alt = |s: f64| path.alt_ft(s, &r, &climb, &st, &AIRLINER, Some(100.0));
        assert_eq!(alt(0.0), 300.0);
        // About 600 ft a mile at first.
        assert!((alt(st.roll + NM) - 900.0).abs() < 20.0, "{}", alt(st.roll + NM));
        assert_eq!(alt(path.len / 2.0), 20_000.0);
        // On the 3° glide slope 5 NM out, 50 ft over the threshold.
        assert!((alt(path.len - 5.0 * NM) - (150.0 + 5.0 * FT_PER_NM)).abs() < 1.0);
        assert!((alt(path.len) - 150.0).abs() < 1.0);
    }
}
