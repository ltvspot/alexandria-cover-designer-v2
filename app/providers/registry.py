"""
Provider registry with simple circuit-breaker per provider.
"""
import asyncio
import logging
import time
from typing import Dict, Optional

from app.providers.base import BaseProvider, GenerationResult
from app.providers.openrouter import OpenRouterProvider

logger = logging.getLogger(__name__)


class CircuitBreaker:
    """Simple circuit breaker: open after N consecutive failures, reset after timeout."""

    def __init__(self, failure_threshold: int = 3, reset_timeout: float = 60.0):
        self.failure_threshold = failure_threshold
        self.reset_timeout = reset_timeout
        self._failures = 0
        self._opened_at: Optional[float] = None

    @property
    def is_open(self) -> bool:
        if self._opened_at is None:
            return False
        if time.monotonic() - self._opened_at > self.reset_timeout:
            # Auto-reset
            self._failures = 0
            self._opened_at = None
            return False
        return True

    def record_success(self) -> None:
        self._failures = 0
        self._opened_at = None

    def record_failure(self) -> None:
        self._failures += 1
        if self._failures >= self.failure_threshold:
            self._opened_at = time.monotonic()
            logger.warning("Circuit breaker opened after %d failures", self._failures)


class ProviderRegistry:
    def __init__(self):
        self._providers: Dict[str, BaseProvider] = {}
        self._breakers: Dict[str, CircuitBreaker] = {}
        self._register_defaults()

    def _register_defaults(self) -> None:
        self.register("openrouter", OpenRouterProvider())

    def register(self, name: str, provider: BaseProvider) -> None:
        self._providers[name] = provider
        self._breakers[name] = CircuitBreaker()
        logger.info("Registered provider: %s", name)

    def get_provider(self, name: str = "openrouter") -> Optional[BaseProvider]:
        p = self._providers.get(name)
        if p and not self._breakers[name].is_open:
            return p
        return None

    async def generate(
        self,
        prompt: str,
        model_id: str,
        provider_name: str = "openrouter",
    ) -> GenerationResult:
        provider = self.get_provider(provider_name)
        if not provider:
            return GenerationResult(
                success=False,
                error=f"Provider '{provider_name}' unavailable or circuit open",
                model=model_id,
            )

        result = await provider.generate(prompt, model_id)

        breaker = self._breakers[provider_name]
        if result.success:
            breaker.record_success()
        else:
            breaker.record_failure()

        return result


# Global singleton
registry = ProviderRegistry()
