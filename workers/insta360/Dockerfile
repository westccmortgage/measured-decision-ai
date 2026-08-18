# syntax=docker/dockerfile:1.7
FROM nvidia/cuda:11.7.1-devel-ubuntu22.04 AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends g++ xz-utils file libx11-6 libgomp1 libxcb1 libpng16-16 libgl1 libegl1 libglx0 libglvnd0 libjpeg-turbo8 libxdmcp6 libbsd0 libxau6 libmd0 libxext6 libvulkan1 libvulkan-dev vulkan-tools libglfw3-dev libdc1394-dev mesa-utils && rm -rf /var/lib/apt/lists/*
COPY install-sdk.sh /usr/local/bin/install-sdk.sh
RUN --mount=type=secret,id=insta360_sdk sh /usr/local/bin/install-sdk.sh /run/secrets/insta360_sdk
COPY stitch360.cc /src/stitch360.cc
RUN g++ /src/stitch360.cc -O2 -std=c++11 -I/usr/local/include -L/usr/local/lib -lMediaSDK -lpthread -Wl,--allow-shlib-undefined -o /usr/local/bin/stitch360

FROM nvidia/cuda:11.7.1-runtime-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg xz-utils libx11-6 libgomp1 libxcb1 libpng16-16 libgl1 libegl1 libglx0 libglvnd0 libjpeg-turbo8 libxdmcp6 libbsd0 libxau6 libmd0 libxext6 libvulkan1 libglfw3 libdc1394-25 && rm -rf /var/lib/apt/lists/*
COPY install-sdk.sh /usr/local/bin/install-sdk.sh
RUN --mount=type=secret,id=insta360_sdk sh /usr/local/bin/install-sdk.sh /run/secrets/insta360_sdk
COPY --from=build /usr/local/bin/stitch360 /usr/local/bin/stitch360
COPY requirements.txt /app/requirements.txt
RUN pip3 install --no-cache-dir -r /app/requirements.txt
COPY worker.py /app/worker.py
RUN mkdir -p /app/models && cp -a /usr/local/share/insta360/models/. /app/models/ 2>/dev/null || true
WORKDIR /app
CMD ["python3", "worker.py"]
