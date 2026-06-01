from fastapi import APIRouter, HTTPException
from app.schemas.embedding import EmbedRequest, EmbedResponse
from app.services.embedding_service import encode_texts

router = APIRouter()


@router.post("/", response_model=EmbedResponse)
def get_embeddings(req: EmbedRequest):
    try:
        vectors, model_name = encode_texts(req.texts, req.normalize)
        return EmbedResponse(embeddings=vectors, model=model_name)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
