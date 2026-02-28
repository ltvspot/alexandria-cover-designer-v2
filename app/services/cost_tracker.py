"""
Cost tracking — thin wrapper around database cost_ledger.
"""
import logging
from typing import Any, Dict, Optional

from app.database import get_cost_summary, get_monthly_cost, record_cost
from app.config import BUDGET_LIMIT_USD

logger = logging.getLogger(__name__)


async def track_cost(
    model: str,
    cost_usd: float,
    job_id: Optional[str] = None,
    book_id: Optional[str] = None,
    tokens_in: int = 0,
    tokens_out: int = 0,
    duration_ms: int = 0,
) -> None:
    await record_cost(
        job_id=job_id,
        book_id=book_id,
        model=model,
        cost_usd=cost_usd,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        duration_ms=duration_ms,
    )


async def get_budget_status() -> Dict[str, Any]:
    summary = await get_cost_summary()
    monthly = await get_monthly_cost()
    remaining = BUDGET_LIMIT_USD - monthly
    return {
        "budget_limit_usd": BUDGET_LIMIT_USD,
        "monthly_used_usd": round(monthly, 4),
        "remaining_usd": round(remaining, 4),
        "today_usd": round(summary.get("today") or 0.0, 4),
        "all_time_usd": round(summary.get("total_all_time") or 0.0, 4),
        "budget_exhausted": remaining <= 0,
    }
