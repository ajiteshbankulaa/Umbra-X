use std::f64::consts::PI;

const RADIUS_M: f64 = 1_737_400.0;
const RAD: f64 = PI / 180.0;
const SOLAR_HALF_DEG: f64 = 0.2665;
const SOLAR_RADIUS_M: f64 = 6.957e8;
const EARTH_RADIUS_M: f64 = 6_371_000.0;
const MIN_PHYSICAL_SUN_DIST_M: f64 = 1.0e11;
const MIN_PHYSICAL_EARTH_DIST_M: f64 = 1.0e8;
const SOLAR_THRESHOLD: f64 = 0.1;

#[inline]
pub fn horizon_at(profile: &[f32; 360], az: f64) -> f64 {
    let wrapped = if az >= 360.0 || az < 0.0 {
        az.rem_euclid(360.0)
    } else {
        az
    };
    let i = (wrapped.floor() as usize) % 360;
    let next = (i + 1) % 360;
    let a = profile[i] as f64;
    let b = profile[next] as f64;
    a + (b - a) * (wrapped - (i as f64))
}

#[inline]
pub fn solar_semi_diameter_deg(sun_dist_m: f64) -> f64 {
    if !(sun_dist_m > MIN_PHYSICAL_SUN_DIST_M) {
        return SOLAR_HALF_DEG;
    }
    (SOLAR_RADIUS_M / sun_dist_m).min(1.0).asin() / RAD
}

#[inline]
pub fn earth_eclipse_factor_from_vecs(
    sx: f64, sy: f64, sz: f64,
    ex: f64, ey: f64, ez: f64,
) -> f64 {
    let d_sun2 = sx * sx + sy * sy + sz * sz;
    let d_earth2 = ex * ex + ey * ey + ez * ez;
    if !(d_sun2 > MIN_PHYSICAL_SUN_DIST_M * MIN_PHYSICAL_SUN_DIST_M)
        || !(d_earth2 > MIN_PHYSICAL_EARTH_DIST_M * MIN_PHYSICAL_EARTH_DIST_M)
        || !(d_sun2 > d_earth2)
    {
        return 1.0;
    }
    let d_sun = d_sun2.sqrt();
    let d_earth = d_earth2.sqrt();
    let dot = (sx * ex + sy * ey + sz * ez) / (d_sun * d_earth);
    if dot < 0.999 {
        return 1.0;
    }
    let (usx, usy, usz) = (sx / d_sun, sy / d_sun, sz / d_sun);
    let (uex, uey, uez) = (ex / d_earth, ey / d_earth, ez / d_earth);
    let cx = usy * uez - usz * uey;
    let cy = usz * uex - usx * uez;
    let cz = usx * uey - usy * uex;
    let sep = (cx * cx + cy * cy + cz * cz).sqrt().atan2(dot);
    let r_s = (SOLAR_RADIUS_M / d_sun).min(1.0).asin();
    let r_e = (EARTH_RADIUS_M / d_earth).min(1.0).asin();
    if sep >= r_s + r_e {
        return 1.0;
    }
    if sep <= r_e - r_s {
        return 0.0;
    }
    if sep <= r_s - r_e {
        return (1.0 - (r_e * r_e) / (r_s * r_s)).max(0.0);
    }
    let d2 = sep * sep;
    let r_s2 = r_s * r_s;
    let r_e2 = r_e * r_e;
    let a1 = ((d2 + r_s2 - r_e2) / (2.0 * sep * r_s)).clamp(-1.0, 1.0).acos();
    let a2 = ((d2 + r_e2 - r_s2) / (2.0 * sep * r_e)).clamp(-1.0, 1.0).acos();
    let k = (-sep + r_s + r_e) * (sep + r_s - r_e) * (sep - r_s + r_e) * (sep + r_s + r_e);
    let overlap = r_s2 * a1 + r_e2 * a2 - 0.5 * k.max(0.0).sqrt();
    (1.0 - overlap / (PI * r_s2)).clamp(0.0, 1.0)
}

#[inline]
pub fn disk_fraction_with_radius(clearance_deg: f64, semi_diameter_deg: f64) -> f64 {
    let r = if semi_diameter_deg > 0.0 {
        semi_diameter_deg
    } else {
        SOLAR_HALF_DEG
    };
    let x = (clearance_deg / r).clamp(-1.0, 1.0);
    ((-x).acos() + x * (1.0 - x * x).sqrt()) / PI
}

#[inline]
pub fn disk_fraction(clearance_deg: f64) -> f64 {
    disk_fraction_with_radius(clearance_deg, SOLAR_HALF_DEG)
}

pub struct Scratch {
    pub sun96: Vec<u8>,
    pub earth96: Vec<u8>,
    pub sun48: Vec<u8>,
    pub earth48: Vec<u8>,
    pub gaps: Vec<u32>,
    pub next_s96: Vec<i32>,
    pub next_e96: Vec<i32>,
    pub next_s48: Vec<i32>,
    pub next_e48: Vec<i32>,
}

impl Scratch {
    pub fn with_capacity(n: usize) -> Self {
        Self {
            sun96: vec![0; n],
            earth96: vec![0; n],
            sun48: vec![0; n],
            earth48: vec![0; n],
            gaps: vec![0; n + 1],
            next_s96: vec![0; n + 1],
            next_e96: vec![0; n + 1],
            next_s48: vec![0; n + 1],
            next_e48: vec![0; n + 1],
        }
    }

    pub fn ensure(&mut self, n: usize) {
        if self.sun96.len() < n {
            self.sun96.resize(n, 0);
            self.earth96.resize(n, 0);
            self.sun48.resize(n, 0);
            self.earth48.resize(n, 0);
        }
        if self.gaps.len() < n + 1 {
            self.gaps.resize(n + 1, 0);
            self.next_s96.resize(n + 1, 0);
            self.next_e96.resize(n + 1, 0);
            self.next_s48.resize(n + 1, 0);
            self.next_e48.resize(n + 1, 0);
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn search_observer_dual_core(
    lat_deg: f64,
    lon_deg: f64,
    height_m: f64,
    mast_m: f64,
    vectors: &[f64],
    n: usize,
    steps: usize,
    step_minutes: usize,
    dark_limit_h: f64,
    earth_limit_h: f64,
    sigma: f64,
    h96: &[f32; 360],
    h48: &[f32; 360],
    err: Option<&[f32; 360]>,
    cov: &[u8; 360],
    sc: &mut Scratch,
    out_starts: &mut Vec<i32>,
) {
    out_starts.clear();
    if n == 0 || vectors.len() < n * 12 || step_minutes == 0 || steps > n {
        return;
    }
    sc.ensure(n);

    let a = lat_deg * RAD;
    let b = lon_deg * RAD;
    let (sin_a, cos_a) = a.sin_cos();
    let (sin_b, cos_b) = b.sin_cos();

    let up0 = cos_a * cos_b;
    let up1 = cos_a * sin_b;
    let up2 = sin_a;

    let n0 = -sin_a * cos_b;
    let n1 = -sin_a * sin_b;
    let n2 = cos_a;

    let e0 = -sin_b;
    let e1 = cos_b;
    let e2 = 0.0;

    let r = RADIUS_M + height_m + mast_m;
    let rx = r * up0;
    let ry = r * up1;
    let rz = r * up2;

    sc.gaps[0] = 0;
    for i in 0..n {
        let off = i * 12;
        let sx = vectors[off] - rx;
        let sy = vectors[off + 1] - ry;
        let sz = vectors[off + 2] - rz;
        let se = sx * e0 + sy * e1 + sz * e2;
        let sn = sx * n0 + sy * n1 + sz * n2;
        let su = sx * up0 + sy * up1 + sz * up2;
        let saz = (se.atan2(sn) / RAD + 360.0).rem_euclid(360.0);
        let sel = su.atan2(sn.hypot(se)) / RAD;

        let ex = vectors[off + 3] - rx;
        let ey = vectors[off + 4] - ry;
        let ez = vectors[off + 5] - rz;
        let ee = ex * e0 + ey * e1 + ez * e2;
        let en = ex * n0 + ey * n1 + ez * n2;
        let eu = ex * up0 + ey * up1 + ez * up2;
        let eaz = (ee.atan2(en) / RAD + 360.0).rem_euclid(360.0);
        let eel = eu.atan2(en.hypot(ee)) / RAD;

        let si = (saz.floor() as usize) % 360;
        let si_next = (si + 1) % 360;
        let sf = saz - (si as f64);

        let ei = (eaz.floor() as usize) % 360;
        let ei_next = (ei + 1) % 360;
        let ef = eaz - (ei as f64);

        let (s_err, e_err) = if sigma != 0.0 {
            if let Some(err_prof) = err {
                let sa = err_prof[si] as f64;
                let sb = err_prof[si_next] as f64;
                let ea = err_prof[ei] as f64;
                let eb = err_prof[ei_next] as f64;
                ((sa + (sb - sa) * sf) * sigma, (ea + (eb - ea) * ef) * sigma)
            } else {
                (0.0, 0.0)
            }
        } else {
            (0.0, 0.0)
        };

        let sh96 = (h96[si] as f64) + ((h96[si_next] as f64) - (h96[si] as f64)) * sf + s_err;
        let sh48 = (h48[si] as f64) + ((h48[si_next] as f64) - (h48[si] as f64)) * sf + s_err;
        let sun_semi = solar_semi_diameter_deg((sx * sx + sy * sy + sz * sz).sqrt());
        let ec = earth_eclipse_factor_from_vecs(sx, sy, sz, ex, ey, ez);
        sc.sun96[i] = u8::from(disk_fraction_with_radius(sel - sh96, sun_semi) * ec < SOLAR_THRESHOLD);
        sc.sun48[i] = u8::from(disk_fraction_with_radius(sel - sh48, sun_semi) * ec < SOLAR_THRESHOLD);

        let eh96 = (h96[ei] as f64) + ((h96[ei_next] as f64) - (h96[ei] as f64)) * ef + e_err;
        let eh48 = (h48[ei] as f64) + ((h48[ei_next] as f64) - (h48[ei] as f64)) * ef + e_err;
        sc.earth96[i] = u8::from(eel <= eh96);
        sc.earth48[i] = u8::from(eel <= eh48);

        let ceil_s = (saz.ceil() as usize) % 360;
        let ceil_e = (eaz.ceil() as usize) % 360;
        let ok = cov[si] != 0 && cov[ceil_s] != 0 && cov[ei] != 0 && cov[ceil_e] != 0;
        sc.gaps[i + 1] = sc.gaps[i] + u32::from(!ok);
    }

    let allowed_dark = (dark_limit_h * 60.0 / (step_minutes as f64) + 1e-9).floor() as usize;
    let allowed_earth = (earth_limit_h * 60.0 / (step_minutes as f64) + 1e-9).floor() as usize;

    let mut r_s96 = 0usize;
    let mut r_e96 = 0usize;
    let mut r_s48 = 0usize;
    let mut r_e48 = 0usize;
    let mut cur_s96 = n as i32;
    let mut cur_e96 = n as i32;
    let mut cur_s48 = n as i32;
    let mut cur_e48 = n as i32;

    sc.next_s96[n] = cur_s96;
    sc.next_e96[n] = cur_e96;
    sc.next_s48[n] = cur_s48;
    sc.next_e48[n] = cur_e48;

    for i in (0..n).rev() {
        let idx_i32 = i as i32;
        r_s96 = if sc.sun96[i] != 0 { r_s96 + 1 } else { 0 };
        if r_s96 > allowed_dark {
            cur_s96 = idx_i32;
        }
        sc.next_s96[i] = cur_s96;

        r_e96 = if sc.earth96[i] != 0 { r_e96 + 1 } else { 0 };
        if r_e96 > allowed_earth {
            cur_e96 = idx_i32;
        }
        sc.next_e96[i] = cur_e96;

        r_s48 = if sc.sun48[i] != 0 { r_s48 + 1 } else { 0 };
        if r_s48 > allowed_dark {
            cur_s48 = idx_i32;
        }
        sc.next_s48[i] = cur_s48;

        r_e48 = if sc.earth48[i] != 0 { r_e48 + 1 } else { 0 };
        if r_e48 > allowed_earth {
            cur_e48 = idx_i32;
        }
        sc.next_e48[i] = cur_e48;
    }

    let step_inc = 60 / step_minutes;
    let allowed_dark_i32 = allowed_dark as i32;
    let allowed_earth_i32 = allowed_earth as i32;
    let mut start = 0usize;
    while start + steps <= n {
        let end = start + steps;
        let end_i32 = end as i32;
        if sc.next_s96[start] + allowed_dark_i32 >= end_i32
            && sc.next_e96[start] + allowed_earth_i32 >= end_i32
            && sc.next_s48[start] + allowed_dark_i32 >= end_i32
            && sc.next_e48[start] + allowed_earth_i32 >= end_i32
            && sc.gaps[end] == sc.gaps[start]
        {
            out_starts.push(start as i32);
        }
        start += step_inc;
    }
}

// --- Persistent WASM ABI State (zero heap churn across pads) ---
use std::cell::UnsafeCell;

struct WasmBuffers {
    vectors: Vec<f64>,
    h96: [f32; 360],
    h48: [f32; 360],
    err: [f32; 360],
    cov: [u8; 360],
    scratch: Scratch,
    out_starts: Vec<i32>,
    pack_coords: Vec<f64>,
    pack_slopes: Vec<f32>,
    pack_h96: Vec<f32>,
    pack_h48: Vec<f32>,
    pack_err: Vec<f32>,
    pack_cov: Vec<u8>,
    pack_counts: Vec<i32>,
    pack_starts: Vec<i32>,
}

struct SyncCell(UnsafeCell<WasmBuffers>);
unsafe impl Sync for SyncCell {}

static WASM_STATE: SyncCell = SyncCell(UnsafeCell::new(WasmBuffers {
    vectors: Vec::new(),
    h96: [0.0; 360],
    h48: [0.0; 360],
    err: [0.0; 360],
    cov: [0; 360],
    scratch: Scratch {
        sun96: Vec::new(),
        earth96: Vec::new(),
        sun48: Vec::new(),
        earth48: Vec::new(),
        gaps: Vec::new(),
        next_s96: Vec::new(),
        next_e96: Vec::new(),
        next_s48: Vec::new(),
        next_e48: Vec::new(),
    },
    out_starts: Vec::new(),
    pack_coords: Vec::new(),
    pack_slopes: Vec::new(),
    pack_h96: Vec::new(),
    pack_h48: Vec::new(),
    pack_err: Vec::new(),
    pack_cov: Vec::new(),
    pack_counts: Vec::new(),
    pack_starts: Vec::new(),
}));

#[no_mangle]
pub extern "C" fn alloc_vectors(len: usize) -> *mut f64 {
    let st = unsafe { &mut *WASM_STATE.0.get() };
    st.vectors.resize(len, 0.0);
    st.vectors.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn h96_ptr() -> *mut f32 {
    let st = unsafe { &mut *WASM_STATE.0.get() };
    st.h96.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn h48_ptr() -> *mut f32 {
    let st = unsafe { &mut *WASM_STATE.0.get() };
    st.h48.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn err_ptr() -> *mut f32 {
    let st = unsafe { &mut *WASM_STATE.0.get() };
    st.err.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn cov_ptr() -> *mut u8 {
    let st = unsafe { &mut *WASM_STATE.0.get() };
    st.cov.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const i32 {
    let st = unsafe { &*WASM_STATE.0.get() };
    st.out_starts.as_ptr()
}

#[no_mangle]
pub extern "C" fn search_pad_dual(
    lat_deg: f64,
    lon_deg: f64,
    height_m: f64,
    mast_m: f64,
    n: usize,
    steps: usize,
    step_minutes: usize,
    dark_limit_h: f64,
    earth_limit_h: f64,
    sigma: f64,
    has_err: i32,
) -> usize {
    let st = unsafe { &mut *WASM_STATE.0.get() };
    let err_opt = if has_err != 0 { Some(&st.err) } else { None };
    search_observer_dual_core(
        lat_deg,
        lon_deg,
        height_m,
        mast_m,
        &st.vectors,
        n,
        steps,
        step_minutes,
        dark_limit_h,
        earth_limit_h,
        sigma,
        &st.h96,
        &st.h48,
        err_opt,
        &st.cov,
        &mut st.scratch,
        &mut st.out_starts,
    );
    st.out_starts.len()
}

#[no_mangle]
pub extern "C" fn alloc_site_pack(node_count: usize) -> usize {
    let st = unsafe { &mut *WASM_STATE.0.get() };
    st.pack_coords.resize(node_count * 3, 0.0);
    st.pack_slopes.resize(node_count, -1.0);
    st.pack_h96.resize(node_count * 360, 0.0);
    st.pack_h48.resize(node_count * 360, 0.0);
    st.pack_err.resize(node_count * 360, 0.0);
    st.pack_cov.resize(node_count * 360, 0);
    st.pack_counts.resize(node_count, 0);
    st.pack_starts.clear();
    node_count
}

#[no_mangle]
pub extern "C" fn pack_coords_ptr() -> *mut f64 {
    let st = unsafe { &mut *WASM_STATE.0.get() };
    st.pack_coords.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn pack_slopes_ptr() -> *mut f32 {
    let st = unsafe { &mut *WASM_STATE.0.get() };
    st.pack_slopes.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn pack_h96_ptr() -> *mut f32 {
    let st = unsafe { &mut *WASM_STATE.0.get() };
    st.pack_h96.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn pack_h48_ptr() -> *mut f32 {
    let st = unsafe { &mut *WASM_STATE.0.get() };
    st.pack_h48.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn pack_err_ptr() -> *mut f32 {
    let st = unsafe { &mut *WASM_STATE.0.get() };
    st.pack_err.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn pack_cov_ptr() -> *mut u8 {
    let st = unsafe { &mut *WASM_STATE.0.get() };
    st.pack_cov.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn pack_counts_ptr() -> *const i32 {
    let st = unsafe { &*WASM_STATE.0.get() };
    st.pack_counts.as_ptr()
}

#[no_mangle]
pub extern "C" fn pack_starts_ptr() -> *const i32 {
    let st = unsafe { &*WASM_STATE.0.get() };
    st.pack_starts.as_ptr()
}

#[no_mangle]
pub extern "C" fn search_site_pack(
    node_count: usize,
    mast_m: f64,
    n: usize,
    steps: usize,
    step_minutes: usize,
    dark_limit_h: f64,
    earth_limit_h: f64,
    slope_limit: f64,
    sigma: f64,
    has_slopes: i32,
    has_err: i32,
    start_min: i32,
    start_max: i32,
) -> usize {
    let st = unsafe { &mut *WASM_STATE.0.get() };
    if node_count == 0
        || st.pack_coords.len() < node_count * 3
        || st.pack_h96.len() < node_count * 360
        || st.pack_h48.len() < node_count * 360
        || st.pack_cov.len() < node_count * 360
    {
        st.pack_counts.fill(0);
        st.pack_starts.clear();
        return 0;
    }
    st.pack_counts.resize(node_count, 0);
    st.pack_starts.clear();

    for node in 0..node_count {
        if has_slopes != 0 {
            let s_val = st.pack_slopes[node] as f64;
            if s_val >= 0.0 && s_val > slope_limit {
                st.pack_counts[node] = 0;
                continue;
            }
        }
        let c_off = node * 3;
        let p_off = node * 360;
        let h96: &[f32; 360] = st.pack_h96[p_off..p_off + 360].try_into().unwrap();
        let h48: &[f32; 360] = st.pack_h48[p_off..p_off + 360].try_into().unwrap();
        let cov: &[u8; 360] = st.pack_cov[p_off..p_off + 360].try_into().unwrap();
        let err_opt: Option<&[f32; 360]> = if has_err != 0 && st.pack_err.len() >= p_off + 360 {
            Some(st.pack_err[p_off..p_off + 360].try_into().unwrap())
        } else {
            None
        };
        search_observer_dual_core(
            st.pack_coords[c_off],
            st.pack_coords[c_off + 1],
            st.pack_coords[c_off + 2],
            mast_m,
            &st.vectors,
            n,
            steps,
            step_minutes,
            dark_limit_h,
            earth_limit_h,
            sigma,
            h96,
            h48,
            err_opt,
            cov,
            &mut st.scratch,
            &mut st.out_starts,
        );
        let mut count = 0i32;
        for &s in &st.out_starts {
            if s >= start_min && s <= start_max {
                st.pack_starts.push(s);
                count += 1;
            }
        }
        st.pack_counts[node] = count;
    }
    st.pack_starts.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_horizon_and_disk_fraction() {
        let mut h = [0.0f32; 360];
        h[359] = 2.0;
        assert!((horizon_at(&h, 359.5) - 1.0).abs() < 1e-12);
        assert_eq!(disk_fraction(-1.0), 0.0);
        assert!((disk_fraction(0.0) - 0.5).abs() < 1e-12);
        assert_eq!(disk_fraction(1.0), 1.0);
    }

    #[test]
    fn test_dual_search_coverage_and_sigma() {
        let n = 24usize;
        let mut vectors = vec![0.0f64; n * 12];
        let r = 1e8f64;
        let el = 1.0f64 * RAD;
        for i in 0..n {
            vectors[i * 12] = r * el.sin();
            vectors[i * 12 + 2] = r * el.cos();
            vectors[i * 12 + 3] = r * el.sin();
            vectors[i * 12 + 5] = r * el.cos();
        }
        let h96 = [0.0f32; 360];
        let h48 = [0.0f32; 360];
        let err = [2.0f32; 360];
        let mut cov = [1u8; 360];
        let mut sc = Scratch::with_capacity(n);
        let mut out = Vec::new();

        search_observer_dual_core(
            0.0,
            0.0,
            0.0,
            0.0,
            &vectors,
            n,
            12,
            5,
            0.0,
            0.0,
            0.0,
            &h96,
            &h48,
            Some(&err),
            &cov,
            &mut sc,
            &mut out,
        );
        assert_eq!(out, vec![0, 12]);

        search_observer_dual_core(
            0.0,
            0.0,
            0.0,
            0.0,
            &vectors,
            n,
            12,
            5,
            0.0,
            0.0,
            1.0,
            &h96,
            &h48,
            Some(&err),
            &cov,
            &mut sc,
            &mut out,
        );
        assert!(out.is_empty());

        cov.fill(0);
        search_observer_dual_core(
            0.0,
            0.0,
            0.0,
            0.0,
            &vectors,
            n,
            12,
            5,
            0.0,
            0.0,
            0.0,
            &h96,
            &h48,
            None,
            &cov,
            &mut sc,
            &mut out,
        );
        assert!(out.is_empty());
    }

    #[test]
    fn test_solar_semidiameter_and_eclipse_physics() {
        // Synthetic test distances keep legacy 0.2665 deg / un-eclipsed behavior.
        assert!((solar_semi_diameter_deg(1e8) - 0.2665).abs() < 1e-12);
        assert_eq!(earth_eclipse_factor_from_vecs(1e8, 0.0, 0.0, 1e8, 0.0, 0.0), 1.0);

        // Real ephemeris perihelion Sun distance (~0.983 AU = 1.471e11 m -> ~0.271 deg).
        let semi = solar_semi_diameter_deg(1.471e11);
        assert!(semi > 0.270 && semi < 0.272);

        // Collinear total lunar eclipse: Sun at 1.496e11 m, Earth at 3.844e8 m.
        assert_eq!(
            earth_eclipse_factor_from_vecs(1.496e11, 0.0, 0.0, 3.844e8, 0.0, 0.0),
            0.0
        );

        // Off-axis non-eclipsed geometry (> 2 deg apart).
        let ang = 2.0 * RAD;
        assert_eq!(
            earth_eclipse_factor_from_vecs(
                1.496e11,
                0.0,
                0.0,
                3.844e8 * ang.cos(),
                3.844e8 * ang.sin(),
                0.0
            ),
            1.0
        );

        // Grazing penumbral/partial eclipse (~1.0 deg angular separation: rE~0.95 deg, rS~0.2665 deg).
        let graze = 1.0 * RAD;
        let partial = earth_eclipse_factor_from_vecs(
            1.496e11,
            0.0,
            0.0,
            3.844e8 * graze.cos(),
            3.844e8 * graze.sin(),
            0.0,
        );
        assert!(partial > 0.0 && partial < 1.0);
    }

    #[test]
    fn test_site_pack_batch_parity() {
        let n = 24usize;
        let vec_ptr = alloc_vectors(n * 12);
        let r = 1e8f64;
        let el = 1.0f64 * RAD;
        unsafe {
            let vecs = std::slice::from_raw_parts_mut(vec_ptr, n * 12);
            for i in 0..n {
                vecs[i * 12] = r * el.sin();
                vecs[i * 12 + 2] = r * el.cos();
                vecs[i * 12 + 3] = r * el.sin();
                vecs[i * 12 + 5] = r * el.cos();
            }
        }
        alloc_site_pack(2);
        unsafe {
            let coords = std::slice::from_raw_parts_mut(pack_coords_ptr(), 6);
            coords.copy_from_slice(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
            let slopes = std::slice::from_raw_parts_mut(pack_slopes_ptr(), 2);
            slopes.copy_from_slice(&[2.0, 8.0]);
            let cov = std::slice::from_raw_parts_mut(pack_cov_ptr(), 720);
            cov.fill(1);
        }
        let total = search_site_pack(2, 0.0, n, 12, 5, 0.0, 0.0, 5.0, 0.0, 1, 0, 0, 24);
        assert_eq!(total, 2);
        unsafe {
            let counts = std::slice::from_raw_parts(pack_counts_ptr(), 2);
            let starts = std::slice::from_raw_parts(pack_starts_ptr(), total);
            assert_eq!(counts, &[2, 0]);
            assert_eq!(starts, &[0, 12]);
        }
    }
}
