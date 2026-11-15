use std::f64::consts::PI;

const RADIUS_M: f64 = 1_737_400.0;
const RAD: f64 = PI / 180.0;
const SOLAR_HALF_DEG: f64 = 0.2665;
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
pub fn disk_fraction(clearance_deg: f64) -> f64 {
    let x = (clearance_deg / SOLAR_HALF_DEG).clamp(-1.0, 1.0);
    ((-x).acos() + x * (1.0 - x * x).sqrt()) / PI
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
        sc.sun96[i] = u8::from(disk_fraction(sel - sh96) < SOLAR_THRESHOLD);
        sc.sun48[i] = u8::from(disk_fraction(sel - sh48) < SOLAR_THRESHOLD);

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
}
