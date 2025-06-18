from typing import Dict
import math
import pandas as pd
import numpy as np
from scipy.stats import linregress


class PKAnalyzer:
    """
    A class to compute PK parameters from time-concentration data.
    """

    def __init__(self, time: np.ndarray, concentration: np.ndarray, dose: float = 0):
        self.time = time
        self.conc = concentration
        self.dose = dose

    def cmax(self) -> float:
        return float(np.max(self.conc))

    def tmax(self) -> float:
        return float(self.time[np.argmax(self.conc)])

    def auc_last(self) -> float:
        return float(np.trapezoid(self.conc, self.time))

    def clearance(self) -> float:
        auc = self.auc_last()
        if self.dose > 0 and auc > 0:
            return self.dose / auc
        return np.nan

    def half_life(self) -> float:
        """
        Estimate terminal half-life based on log-linear regression.

        Returns
        -------
        float
            Estimated half-life (T1/2) in same time unit as input.
            Returns np.nan if calculation fails.
        """
        mask = self.conc > 0
        if np.sum(mask) < 3:
            return np.nan

        t_log = self.time[mask]
        log_c = np.log(self.conc[mask])

        slope: float = linregress(t_log, log_c).slope
        if slope >= 0:
            return np.nan
        return round(np.log(2) / abs(slope), 4)

    def analyze_all(self) -> Dict[str, float]:
        return {
            "Cmax": round(self.cmax(), 4),
            "Tmax": round(self.tmax(), 4),
            "AUC": round(self.auc_last(), 4),
            "Clearance": round(self.clearance(), 4) if not np.isnan(self.clearance()) else np.nan,
            "Half-life": self.half_life()
        }


def analyze_pk(df: pd.DataFrame, compartments: list, total_dose: float) -> Dict[str, Dict[str, float]]:
    """
    Analyze PK parameters for each compartment using PKAnalyzer.

    Parameters
    ----------
    df : pd.DataFrame
        Time-course data including 'Time' column and compartment columns.
    compartments : list
        Compartment names to analyze.

    Returns
    -------
    dict
        PK results per compartment.
    """
    results = {}
    time = df['Time'].to_numpy()

    for comp in compartments:
        conc = df[comp].to_numpy()
        analyzer = PKAnalyzer(time, conc, total_dose)
        results[comp] = analyzer.analyze_all()

    return clean_pk_summary(results)


def clean_pk_summary(pk_summary: dict) -> dict:
    """Convert any NaN values to null (None) for JSON compatibility."""
    cleaned = {}
    for comp, metrics in pk_summary.items():
        cleaned[comp] = {
            k: (None if isinstance(v, float) and (math.isnan(v) or math.isinf(v)) else v)
            for k, v in metrics.items()
        }
    return cleaned

