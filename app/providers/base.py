"""
Abstract base class for image-generation providers.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, Optional


@dataclass
class GenerationResult:
    success: bool
    image_bytes: Optional[bytes] = None
    image_format: str = "jpeg"
    model: str = ""
    cost_usd: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0
    duration_ms: int = 0
    error: Optional[str] = None
    raw_response: Optional[Dict[str, Any]] = None


class BaseProvider(ABC):
    name: str = "base"

    @abstractmethod
    async def generate(
        self,
        prompt: str,
        model_id: str,
        **kwargs,
    ) -> GenerationResult:
        """Generate an image from a text prompt. Returns GenerationResult."""
        ...

    @abstractmethod
    def is_available(self) -> bool:
        """Return True if the provider is currently usable."""
        ...
