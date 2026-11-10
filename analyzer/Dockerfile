FROM python:3.11-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 tzdata curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# PyTorch só CPU (a máquina não tem GPU NVIDIA) para a imagem não ficar gigante.
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Modelos: YOLOv8 (objetos) e YuNet + SFace do OpenCV (detecção e reconhecimento facial).
WORKDIR /opt/models
RUN python -c "from ultralytics import YOLO; YOLO('yolov8s.pt')" \
 && curl -fsSL -o yunet.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx \
 && curl -fsSL -o sface.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx

WORKDIR /app
COPY analyzer.py gate.py notify.py alerts.py retention.py garage.py ./

ENV HOME=/tmp YOLO_CONFIG_DIR=/tmp OPENCV_FFMPEG_CAPTURE_OPTIONS="rtsp_transport;tcp" PYTHONUNBUFFERED=1
CMD ["python", "analyzer.py"]
