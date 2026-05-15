import os
from dotenv import load_dotenv

load_dotenv()

GEMMA_4_31B = "gemma-4-31b-it"
DEFAULT_PREDICTION_MODEL = GEMMA_4_31B
DEFAULT_ATTRIBUTION_MODEL = GEMMA_4_31B


def is_gemma_model(model: str) -> bool:
    return model.lower().startswith("gemma")


def get_prediction_model() -> str:
    return os.getenv("GEMINI_MODEL_PREDICTION", DEFAULT_PREDICTION_MODEL)


def get_attribution_model() -> str:
    return os.getenv("GEMINI_MODEL_ATTRIBUTION", DEFAULT_ATTRIBUTION_MODEL)


def is_api_key_configured() -> bool:
    key = os.getenv("GEMINI_API_KEY")
    return bool(key and key != "your_gemini_api_key_here")
