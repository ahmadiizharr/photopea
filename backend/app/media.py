"""Decode untrusted uploads and write clean copies.

Everything is re-encoded from pixels, so EXIF/GPS and anything smuggled after
the image data never reaches disk.
"""

import io
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

Image.MAX_IMAGE_PIXELS = 30_000_000
ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP"}


class BadImage(ValueError):
    pass


def decode(data: bytes, max_px: tuple[int, int]) -> Image.Image:
    try:
        with Image.open(io.BytesIO(data)) as probe:
            if probe.format not in ALLOWED_FORMATS:
                raise BadImage("format harus JPEG, PNG, atau WEBP")
            w, h = probe.size
            if w > max_px[0] or h > max_px[1]:
                raise BadImage(f"gambar terlalu besar ({w}×{h})")
            probe.load()
            img = ImageOps.exif_transpose(probe)
            return img.convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as e:
        raise BadImage("bukan gambar yang valid") from e


def save_jpeg(img: Image.Image, path: Path, long_side: int | None = None) -> None:
    if long_side and max(img.size) > long_side:
        img = img.copy()
        img.thumbnail((long_side, long_side), Image.Resampling.LANCZOS)
    img.save(path, "JPEG", quality=90, optimize=True, progressive=True)


def save_gif(shots: list[Image.Image], path: Path, width: int, frame_ms: int = 500) -> None:
    # GIF frames must share one size; shots from the file-picker fallback may not.
    size = (width, round(shots[0].height * width / shots[0].width))
    frames = [
        ImageOps.fit(shot, size, Image.Resampling.LANCZOS).quantize(colors=200, dither=Image.Dither.FLOYDSTEINBERG)
        for shot in shots
    ]
    frames[0].save(path, "GIF", save_all=True, append_images=frames[1:], duration=frame_ms, loop=0, optimize=True, disposal=1)
