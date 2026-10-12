//! The benchmark scenario, in the local east/north/up frame at the scenario centre (metres). Mirrors
//! `../cesium-baseline/src/scenario.ts` line for line: both engines must fly the same path over the same units.

use bevy::prelude::Resource;
use serde::Deserialize;
use std::f64::consts::TAU;

#[derive(Deserialize)]
pub struct Center {
    pub lat: f64,
    pub lon: f64,
    pub elev: f64,
}

#[derive(Deserialize, Resource)]
pub struct Scenario {
    pub center: Center,
    pub units: usize,
    pub seed: u32,
    /// Screen-space error of the photorealistic mesh in CSS pixels, Cesium's unit (`PHOTOREAL_SSE`).
    pub sse: f64,
    // `legs` is read by bench.js only.
}

pub fn load() -> Scenario {
    serde_json::from_str(include_str!("../../scenario.json")).expect("scenario.json")
}

/// East, north, up.
pub type Enu = [f64; 3];

/// Camera eye and look-at target at scene time `t` (s).
pub fn camera(t: f64) -> (Enu, Enu) {
    let origin = [0.0, 0.0, 0.0];
    if t < 10.0 {
        ([0.0, -1200.0, 600.0], origin)
    } else if t < 30.0 {
        let a = (t - 10.0) / 20.0 * TAU;
        ([1200.0 * a.sin(), -1200.0 * a.cos(), 600.0], origin)
    } else if t < 50.0 {
        let s = (t - 30.0) / 20.0;
        let eye = [-1500.0 + 3000.0 * s, 0.0, 120.0];
        (eye, [eye[0] + 200.0, 0.0, 90.0])
    } else {
        let s = ((t - 50.0) / 20.0).min(1.0);
        let h = 150.0 * (4000.0_f64 / 150.0).powf(s);
        ([0.0, -0.8 * h, h], origin)
    }
}

/// mulberry32, the same stream as the TypeScript side.
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Self(seed)
    }
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6D2B_79F5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(1 | t);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

/// A unit circling at constant speed and altitude.
pub struct Orbit {
    pub center: [f64; 2],
    pub radius: f64,
    pub alt: f64,
    pub omega: f64,
    pub phase: f64,
}

pub fn units(seed: u32, n: usize) -> Vec<Orbit> {
    let mut r = Rng::new(seed);
    (0..n)
        .map(|_| {
            let center = [(r.next() * 2.0 - 1.0) * 1500.0, (r.next() * 2.0 - 1.0) * 1500.0];
            let radius = 100.0 + r.next() * 500.0;
            let alt = 50.0 + r.next() * 250.0;
            let speed = 20.0 + r.next() * 60.0;
            let phase = r.next() * TAU;
            let dir = if r.next() < 0.5 { 1.0 } else { -1.0 };
            Orbit { center, radius, alt, omega: dir * speed / radius, phase }
        })
        .collect()
}

impl Orbit {
    /// Position and unit direction of travel at scene time `t`.
    pub fn at(&self, t: f64) -> (Enu, Enu) {
        let a = self.phase + self.omega * t;
        let (s, c) = a.sin_cos();
        let d = self.omega.signum();
        ([self.center[0] + self.radius * c, self.center[1] + self.radius * s, self.alt], [-s * d, c * d, 0.0])
    }
}
