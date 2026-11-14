"""Diffuse shortwave radiosity on patches with caller-supplied view factors."""

import numpy as np
from scipy.sparse import csr_matrix, eye
from scipy.sparse.linalg import spsolve


def solve_radiosity(incident_w_m2, albedo, view_factors):
    """Return reflected exitance in W/m², including multiple diffuse bounces."""
    incident = np.asarray(incident_w_m2, dtype=float)
    if incident.ndim != 1 or incident.size == 0:
        raise ValueError("Expected a nonempty vector of incident flux")
    rho = np.broadcast_to(np.asarray(albedo, dtype=float), incident.shape)
    factors = csr_matrix(view_factors, dtype=float)
    if factors.shape != (incident.size, incident.size):
        raise ValueError("Expected one view-factor row and column per patch")
    if not np.isfinite(incident).all() or (incident < 0).any():
        raise ValueError("Incident flux must be finite and nonnegative")
    if not np.isfinite(rho).all() or ((rho < 0) | (rho >= 1)).any():
        raise ValueError("Albedo must lie in [0, 1)")
    if not np.isfinite(factors.data).all() or (factors.data < 0).any() or (factors.sum(axis=1) > 1).any():
        raise ValueError("View factors must be nonnegative with row sums at most one")
    transfer = factors.multiply(rho[:, None]).tocsr()
    return spsolve(eye(incident.size, format="csr") - transfer, rho * incident)
