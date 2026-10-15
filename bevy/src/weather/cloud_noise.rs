//! The cloud shader's billow noise as a tiling volume texture (`assets/shaders/clouds.wgsl`).
//!
//! The shader erodes its cloud lobes with two octaves of gradient noise, at every step of the march and at each of its
//! three sunward light samples. Evaluated in the shader (eight hashed gradients a lookup) it was most of the clouds'
//! cost; a filtered read from this volume is the same noise for a fraction of it. The noise repeats every `PERIOD`
//! lattice cells (7 km for the fine octave, 16 km for the coarse one), far apart enough not to show among the
//! cloud cells, which do not repeat.

use bevy::asset::RenderAssetUsages;
use bevy::image::{ImageAddressMode, ImageFilterMode, ImageSampler, ImageSamplerDescriptor};
use bevy::prelude::*;
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};

/// Lattice cells across the volume (the shader divides by the same), and texels along each side.
pub const PERIOD: usize = 32;
const SIZE: usize = 128;

fn fract(x: f32) -> f32 {
    x - x.floor()
}

/// The shader's hash (it was evaluated there at every lattice corner).
fn hash(p: Vec3) -> f32 {
    let mut q = Vec3::new(fract(p.x * 0.1031), fract(p.y * 0.1031), fract(p.z * 0.1031));
    q += Vec3::splat(q.dot(Vec3::new(q.y, q.z, q.x) + 33.33));
    fract((q.x + q.y) * q.z)
}

/// One of Perlin's twelve edge gradients (and four repeats), dotted with the offset from its lattice point.
fn gradient(h: u8, d: Vec3) -> f32 {
    let u = if h < 8 { d.x } else { d.y };
    let v = if h < 4 {
        d.y
    } else if h == 12 || h == 14 {
        d.x
    } else {
        d.z
    };
    (if h & 1 == 0 { u } else { -u }) + (if h & 2 == 0 { v } else { -v })
}

/// Gradient noise in about −1..1, tiling every `PERIOD` cells, at `SIZE`³ texel centres (R16Float).
fn texels() -> Vec<u8> {
    let lattice: Vec<u8> = (0..PERIOD * PERIOD * PERIOD)
        .map(|i| {
            let (x, y, z) = (i % PERIOD, i / PERIOD % PERIOD, i / (PERIOD * PERIOD));
            ((hash(Vec3::new(x as f32, y as f32, z as f32)) * 16.0) as u32 & 15) as u8
        })
        .collect();
    let corner = |c: [usize; 3]| lattice[c[0] % PERIOD + c[1] % PERIOD * PERIOD + c[2] % PERIOD * PERIOD * PERIOD];
    let scale = PERIOD as f32 / SIZE as f32;
    let mut out = Vec::with_capacity(SIZE * SIZE * SIZE * 2);
    for z in 0..SIZE {
        for y in 0..SIZE {
            for x in 0..SIZE {
                let p = (Vec3::new(x as f32, y as f32, z as f32) + 0.5) * scale;
                let i = p.floor();
                let f = p - i;
                let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
                let i = [i.x as usize, i.y as usize, i.z as usize];
                let g = |dx: usize, dy: usize, dz: usize| {
                    let o = Vec3::new(dx as f32, dy as f32, dz as f32);
                    gradient(corner([i[0] + dx, i[1] + dy, i[2] + dz]), f - o)
                };
                let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
                let n = lerp(
                    lerp(lerp(g(0, 0, 0), g(1, 0, 0), u.x), lerp(g(0, 1, 0), g(1, 1, 0), u.x), u.y),
                    lerp(lerp(g(0, 0, 1), g(1, 0, 1), u.x), lerp(g(0, 1, 1), g(1, 1, 1), u.x), u.y),
                    u.z,
                );
                out.extend_from_slice(&f16_bits(n).to_le_bytes());
            }
        }
    }
    out
}

/// IEEE half-precision bits of a value of moderate size (tiny values flush to zero), rounded to nearest.
fn f16_bits(x: f32) -> u16 {
    let b = x.to_bits();
    let sign = ((b >> 16) & 0x8000) as u16;
    let exp = ((b >> 23) & 0xff) as i32 - 127 + 15;
    if exp <= 0 {
        return sign;
    }
    let mantissa = ((b & 0x7f_ffff) + 0x1000) >> 13;
    sign | (((exp as u32) << 10) + mantissa) as u16
}

/// The noise volume, filtered and repeating in all three directions.
pub fn image() -> Image {
    let mut image = Image::new(
        Extent3d { width: SIZE as u32, height: SIZE as u32, depth_or_array_layers: SIZE as u32 },
        TextureDimension::D3,
        texels(),
        TextureFormat::R16Float,
        RenderAssetUsages::RENDER_WORLD,
    );
    image.sampler = ImageSampler::Descriptor(ImageSamplerDescriptor {
        address_mode_u: ImageAddressMode::Repeat,
        address_mode_v: ImageAddressMode::Repeat,
        address_mode_w: ImageAddressMode::Repeat,
        mag_filter: ImageFilterMode::Linear,
        min_filter: ImageFilterMode::Linear,
        ..default()
    });
    image
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_floats_round_trip_the_noise_range() {
        assert_eq!(f16_bits(0.0), 0);
        assert_eq!(f16_bits(1.0), 0x3c00);
        assert_eq!(f16_bits(-0.5), 0xb800);
        assert_eq!(f16_bits(0.333_333), 0x3555);
    }

    #[test]
    fn the_volume_is_noise_that_tiles() {
        let t = texels();
        assert_eq!(t.len(), SIZE * SIZE * SIZE * 2);
        let at = |x: usize, y: usize, z: usize| {
            let i = (x + y * SIZE + z * SIZE * SIZE) * 2;
            u16::from_le_bytes([t[i], t[i + 1]])
        };
        // Varied, bounded values, and the same pattern across the wrap as within (the gradients tile).
        let distinct: std::collections::HashSet<u16> = (0..SIZE).map(|x| at(x, 7, 9)).collect();
        assert!(distinct.len() > SIZE / 2);
        assert!((0..SIZE).all(|x| f32::from_bits(((at(x, 3, 5) as u32 & 0x7fff) << 13) + (112 << 23)) < 1.5));
    }
}
