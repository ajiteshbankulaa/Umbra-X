import json
import os
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor, RandomForestClassifier
from sklearn.linear_model import Ridge
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    brier_score_loss,
    f1_score,
    mean_absolute_error,
    mean_squared_error,
    roc_auc_score,
)
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[2]
DATA_PATH = ROOT / "research" / "ml" / "surrogate_dataset.csv"
OUT_PATH = ROOT / "research" / "benchmarks" / "ml_surrogate_report.json"

STATIC_COLS = [
    "mastM",
    "latDeg",
    "lonDeg",
    "elevM",
    "slopeDeg",
    "psr",
    "h48Mean",
    "h48Std",
    "h48Max",
    "h48P90",
    "h48EarthMax",
    "h48EarthMean",
    "h48FracGt15",
    "h48FracGt0",
    "h96Mean",
    "h96Max",
    "hDiffMean",
    "hDiffMax",
    "hDiffEarthMax",
    "errMean",
    "errP90",
    "errMax",
    "errEarthMean",
    "distFarFrac",
    "sunElMean",
    "sunElMin",
    "sunElMax",
    "earthElMean",
    "earthElMin",
    "earthElMax",
]
FAST48_COLS = STATIC_COLS + ["ref48DarkH", "ref48EarthH", "ref48SolarH", "ref48EarthVisH"]


def load_csv(path: Path):
    with path.open("r", encoding="utf-8") as f:
        header = f.readline().strip().split(",")
        rows = [line.strip().split(",") for line in f if line.strip()]
    col_idx = {name: i for i, name in enumerate(header)}
    data = {
        "site": np.array([r[col_idx["site"]] for r in rows]),
        "node": np.array([int(r[col_idx["node"]]) for r in rows]),
        "spatialBlock": np.array([int(r[col_idx["spatialBlock"]]) for r in rows]),
        "temporalSplit": np.array([r[col_idx["temporalSplit"]] for r in rows]),
    }
    numeric_cols = [c for c in header if c not in ("site", "temporalSplit")]
    for c in numeric_cols:
        data[c] = np.array([float(r[col_idx[c]]) for r in rows], dtype=np.float32)
    return data


def compute_ece(y_true: np.ndarray, y_prob: np.ndarray, n_bins: int = 10) -> float:
    bins = np.linspace(0.0, 1.0, n_bins + 1)
    ece = 0.0
    n = len(y_true)
    for b0, b1 in zip(bins[:-1], bins[1:]):
        mask = (y_prob >= b0) & (y_prob < b1 if b1 < 1.0 else y_prob <= b1)
        if np.any(mask):
            acc = float(np.mean(y_true[mask]))
            conf = float(np.mean(y_prob[mask]))
            ece += (np.sum(mask) / n) * abs(acc - conf)
    return round(float(ece), 5)


def screening_recall_curve(y_true: np.ndarray, y_score: np.ndarray, budgets=(0.1, 0.2, 0.3, 0.4, 0.5)):
    order = np.argsort(-y_score)
    total_pos = max(1, int(np.sum(y_true)))
    n = len(y_true)
    out = {}
    for b in budgets:
        k = max(1, int(round(b * n)))
        hits = int(np.sum(y_true[order[:k]]))
        out[f"top_{int(b * 100)}pct_recall"] = round(hits / total_pos, 4)
    return out


class ResidualSurrogateMLP(nn.Module):
    def __init__(self, in_dim: int, hidden: int = 96, dropout: float = 0.15):
        super().__init__()
        self.in_proj = nn.Sequential(
            nn.Linear(in_dim, hidden),
            nn.LayerNorm(hidden),
            nn.SiLU(),
        )
        self.block1 = nn.Sequential(
            nn.Linear(hidden, hidden),
            nn.LayerNorm(hidden),
            nn.SiLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden, hidden),
        )
        self.act = nn.SiLU()
        self.drop = nn.Dropout(dropout)
        self.cls_head = nn.Linear(hidden, 1)
        self.reg_head = nn.Linear(hidden, 1)

    def forward(self, x):
        h = self.in_proj(x)
        h = self.act(h + self.block1(h))
        h = self.drop(h)
        return self.cls_head(h).squeeze(-1), self.reg_head(h).squeeze(-1)


def train_pytorch_surrogate(X_tr, y_cls_tr, y_reg_tr, X_te, seed: int = 42, epochs: int = 35):
    torch.manual_seed(seed)
    np.random.seed(seed)

    scaler = StandardScaler()
    X_tr_s = scaler.fit_transform(X_tr).astype(np.float32)
    X_te_s = scaler.transform(X_te).astype(np.float32)

    # Carve 15% internal val set from training rows for temperature calibration
    rng = np.random.default_rng(seed)
    perm = rng.permutation(len(X_tr_s))
    n_val = max(128, int(0.15 * len(X_tr_s)))
    val_idx, tr_idx = perm[:n_val], perm[n_val:]

    reg_mean = float(np.mean(y_reg_tr[tr_idx]))
    reg_std = max(1.0, float(np.std(y_reg_tr[tr_idx])))

    ds = torch.utils.data.TensorDataset(
        torch.from_numpy(X_tr_s[tr_idx]),
        torch.from_numpy(y_cls_tr[tr_idx].astype(np.float32)),
        torch.from_numpy(((y_reg_tr[tr_idx] - reg_mean) / reg_std).astype(np.float32)),
    )
    loader = torch.utils.data.DataLoader(ds, batch_size=256, shuffle=True)

    model = ResidualSurrogateMLP(X_tr_s.shape[1], hidden=96, dropout=0.15)
    opt = torch.optim.AdamW(model.parameters(), lr=2.5e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
    bce = nn.BCEWithLogitsLoss()
    huber = nn.SmoothL1Loss()

    t0 = time.perf_counter()
    model.train()
    for _ in range(epochs):
        for xb, yb_cls, yb_reg in loader:
            opt.zero_grad()
            logit, reg = model(xb)
            loss = bce(logit, yb_cls) + 0.5 * huber(reg, yb_reg)
            loss.backward()
            opt.step()
        sched.step()
    train_s = time.perf_counter() - t0

    # Fit scalar temperature on validation split logits
    model.eval()
    with torch.no_grad():
        val_logits, _ = model(torch.from_numpy(X_tr_s[val_idx]))
    val_targets = torch.from_numpy(y_cls_tr[val_idx].astype(np.float32))
    temp = nn.Parameter(torch.ones(1))
    t_opt = torch.optim.LBFGS([temp], lr=0.05, max_iter=50)

    def _closure():
        t_opt.zero_grad()
        loss = nn.functional.binary_cross_entropy_with_logits(val_logits / temp.clamp(0.1, 10.0), val_targets)
        loss.backward()
        return loss

    t_opt.step(_closure)
    T_val = float(temp.clamp(0.1, 10.0).item())

    # Deterministic eval + 16-pass MC Dropout uncertainty
    X_te_t = torch.from_numpy(X_te_s)
    with torch.no_grad():
        raw_logits, raw_reg = model(X_te_t)
        raw_probs = torch.sigmoid(raw_logits).numpy()
        cal_probs = torch.sigmoid(raw_logits / T_val).numpy()
        reg_pred = raw_reg.numpy() * reg_std + reg_mean

    model.train()
    mc_cls, mc_reg = [], []
    with torch.no_grad():
        for _ in range(16):
            lg, rg = model(X_te_t)
            mc_cls.append(torch.sigmoid(lg / T_val).numpy())
            mc_reg.append(rg.numpy() * reg_std + reg_mean)
    mc_cls_arr = np.stack(mc_cls, axis=0)
    mc_reg_arr = np.stack(mc_reg, axis=0)
    return {
        "raw_probs": raw_probs,
        "cal_probs": cal_probs,
        "reg_pred": reg_pred,
        "mc_prob_std": np.std(mc_cls_arr, axis=0),
        "mc_reg_std": np.std(mc_reg_arr, axis=0),
        "temperature": round(T_val, 4),
        "train_sec": round(train_s, 3),
        "param_count": int(sum(p.numel() for p in model.parameters())),
    }


def eval_predictions(y_cls, y_reg, prob, reg_pred):
    cls_pred = (prob >= 0.5).astype(int)
    has_both = len(np.unique(y_cls)) > 1
    return {
        "reg_mae_h": round(float(mean_absolute_error(y_reg, reg_pred)), 3),
        "reg_rmse_h": round(float(np.sqrt(mean_squared_error(y_reg, reg_pred))), 3),
        "cls_accuracy": round(float(accuracy_score(y_cls, cls_pred)), 4),
        "cls_f1": round(float(f1_score(y_cls, cls_pred, zero_division=0)), 4),
        "cls_auroc": round(float(roc_auc_score(y_cls, prob)), 4) if has_both else None,
        "cls_prauc": round(float(average_precision_score(y_cls, prob)), 4) if has_both else None,
        "brier": round(float(brier_score_loss(y_cls, np.clip(prob, 0, 1))), 4),
        "ece": compute_ece(y_cls, np.clip(prob, 0, 1)),
        "screening": screening_recall_curve(y_cls, prob),
    }


def run_split(data, split_name: str, train_mask: np.ndarray, test_mask: np.ndarray, feature_cols, tier_name: str):
    X = np.stack([data[c] for c in feature_cols], axis=1).astype(np.float32)
    y_cls = data["viable96Sig2"].astype(int)
    y_reg = data["sig2_96DarkH"].astype(np.float32)

    X_tr, X_te = X[train_mask], X[test_mask]
    yc_tr, yc_te = y_cls[train_mask], y_cls[test_mask]
    yr_tr, yr_te = y_reg[train_mask], y_reg[test_mask]

    models_out = {}

    # 1. Analytical Baseline
    if tier_name == "tier1_static":
        # Linear ridge + physical slope<=5 & horizon rule
        scaler = StandardScaler()
        ridge = Ridge(alpha=10.0)
        ridge.fit(scaler.fit_transform(X_tr), yr_tr)
        ana_reg = np.clip(ridge.predict(scaler.transform(X_te)), 0.0, 240.0)
        # Heuristic viability score: distance from slope<=5 and predicted dark<=48 & earthSector<=3.0
        slope_te = data["slopeDeg"][test_mask]
        h_earth_te = data["h48EarthMax"][test_mask]
        score = 1.0 / (1.0 + np.exp((slope_te - 5.0) * 1.2 + (ana_reg - 48.0) * 0.08 + (h_earth_te - 4.0) * 0.6))
        models_out["analytical_baseline"] = eval_predictions(yc_te, yr_te, score, ana_reg)
    else:
        # Trust fast 48km nominal simulation directly (with continuous score near limit boundary)
        d48 = data["ref48DarkH"][test_mask]
        e48 = data["ref48EarthH"][test_mask]
        slp = data["slopeDeg"][test_mask]
        ana_reg = d48
        # Margin-based logistic probability around 48km thresholds
        margin = np.minimum(np.minimum(48.0 - d48, 72.0 - e48), (5.0 - slp) * 12.0)
        score = 1.0 / (1.0 + np.exp(-margin * 0.15))
        models_out["analytical_48km_nominal"] = eval_predictions(yc_te, yr_te, score, ana_reg)

    # 2. HistGradientBoosting (scikit-learn)
    t0 = time.perf_counter()
    hgb_cls = HistGradientBoostingClassifier(max_iter=180, max_depth=6, l2_regularization=1.0, random_state=42)
    hgb_reg = HistGradientBoostingRegressor(max_iter=180, max_depth=6, l2_regularization=1.0, random_state=42)
    hgb_cls.fit(X_tr, yc_tr)
    hgb_reg.fit(X_tr, yr_tr)
    hgb_tr_s = time.perf_counter() - t0
    hgb_prob = hgb_cls.predict_proba(X_te)[:, 1]
    hgb_pred_reg = np.clip(hgb_reg.predict(X_te), 0.0, 240.0)
    models_out["hist_gbdt"] = {
        **eval_predictions(yc_te, yr_te, hgb_prob, hgb_pred_reg),
        "train_sec": round(hgb_tr_s, 3),
    }

    # 3. RandomForestClassifier (cls benchmark paired with Ridge reg)
    t0 = time.perf_counter()
    rf_cls = RandomForestClassifier(n_estimators=120, max_depth=12, min_samples_leaf=4, random_state=42, n_jobs=-1)
    rf_cls.fit(X_tr, yc_tr)
    rf_tr_s = time.perf_counter() - t0
    rf_prob = rf_cls.predict_proba(X_te)[:, 1]
    models_out["random_forest"] = {
        **eval_predictions(yc_te, yr_te, rf_prob, hgb_pred_reg),
        "train_sec": round(rf_tr_s, 3),
    }

    # 4. PyTorch Residual MLP + Temperature Scaling + MC Dropout
    nn_res = train_pytorch_surrogate(X_tr, yc_tr, yr_tr, X_te, seed=42, epochs=35)
    raw_metrics = eval_predictions(yc_te, yr_te, nn_res["raw_probs"], np.clip(nn_res["reg_pred"], 0.0, 240.0))
    cal_metrics = eval_predictions(yc_te, yr_te, nn_res["cal_probs"], np.clip(nn_res["reg_pred"], 0.0, 240.0))
    models_out["pytorch_res_mlp"] = {
        **cal_metrics,
        "ece_uncalibrated": raw_metrics["ece"],
        "temperature": nn_res["temperature"],
        "mean_mc_prob_std": round(float(np.mean(nn_res["mc_prob_std"])), 4),
        "mean_mc_reg_std_h": round(float(np.mean(nn_res["mc_reg_std"])), 3),
        "train_sec": nn_res["train_sec"],
        "param_count": nn_res["param_count"],
    }

    # Failure-mode breakdown on HistGBDT & PyTorch MLP
    abs_err_gbdt = np.abs(yr_te - hgb_pred_reg)
    far_mask = data["distFarFrac"][test_mask] > 0.25
    edge_slope_mask = (data["slopeDeg"][test_mask] >= 4.0) & (data["slopeDeg"][test_mask] <= 6.0)
    flip_mask = data["sigma2FlipFail"][test_mask] == 1
    failure_analysis = {
        "testSamples": int(np.sum(test_mask)),
        "testPositiveRate": round(float(np.mean(yc_te)), 4),
        "gbdt_mae_overall_h": round(float(np.mean(abs_err_gbdt)), 3),
        "gbdt_mae_far_field_gt25pct_h": round(float(np.mean(abs_err_gbdt[far_mask])), 3) if np.any(far_mask) else None,
        "gbdt_false_positive_rate_on_2sigma_flips": round(float(np.mean(hgb_prob[flip_mask] >= 0.5)), 4) if np.any(flip_mask) else None,
        "gbdt_accuracy_slope_boundary_4_6deg": round(float(accuracy_score(yc_te[edge_slope_mask], (hgb_prob[edge_slope_mask] >= 0.5).astype(int))), 4) if np.any(edge_slope_mask) else None,
    }

    return {
        "split": split_name,
        "tier": tier_name,
        "trainCount": int(np.sum(train_mask)),
        "testCount": int(np.sum(test_mask)),
        "featureCount": len(feature_cols),
        "models": models_out,
        "failureAnalysis": failure_analysis,
    }


def main():
    t0 = time.perf_counter()
    data = load_csv(DATA_PATH)
    n = len(data["node"])
    splits = {
        "spatial_block_holdout": (data["spatialBlock"] != 3, data["spatialBlock"] == 3),
        "temporal_window_holdout": (data["temporalSplit"] == "early", data["temporalSplit"] == "late"),
        "cross_region_loso_malapert": (data["site"] != "malapert-massif", data["site"] == "malapert-massif"),
    }

    experiments = []
    for split_name, (tr_mask, te_mask) in splits.items():
        for tier_name, cols in [("tier1_static", STATIC_COLS), ("tier2_static_plus_48km", FAST48_COLS)]:
            res = run_split(data, split_name, tr_mask, te_mask, cols, tier_name)
            experiments.append(res)
            gb = res["models"]["hist_gbdt"]
            mlp = res["models"]["pytorch_res_mlp"]
            print(
                f"{split_name:28s} | {tier_name:22s} | "
                f"HGB(MAE={gb['reg_mae_h']}h AUC={gb['cls_auroc']} ECE={gb['ece']}) | "
                f"MLP(MAE={mlp['reg_mae_h']}h AUC={mlp['cls_auroc']} ECE={mlp['ece']})"
            )

    report = {
        "benchmarkVersion": "phase4-ml-surrogate-v1",
        "device": "cpu",
        "torchVersion": torch.__version__,
        "dataset": {
            "path": str(DATA_PATH.relative_to(ROOT)).replace("\\", "/"),
            "sampleCount": n,
            "sites": ["shackleton-ridge", "mons-mouton", "malapert-massif"],
            "missionDays": 10,
            "positiveRateViable96Sig2": round(float(np.mean(data["viable96Sig2"])), 4),
            "positiveRateViable96Nom": round(float(np.mean(data["viable96Nom"])), 4),
            "sigma2FlipFailCount": int(np.sum(data["sigma2FlipFail"])),
            "extentSensitiveDarkCount": int(np.sum(data["extentSensitiveDark"])),
        },
        "elapsedSec": round(time.perf_counter() - t0, 2),
        "experiments": experiments,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Saved ML surrogate report -> {OUT_PATH} ({report['elapsedSec']}s)")


if __name__ == "__main__":
    main()
