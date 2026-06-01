from pydantic import BaseModel


class EmbedRequest(BaseModel):
    texts: list[str]
    normalize: bool = True


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    model: str
