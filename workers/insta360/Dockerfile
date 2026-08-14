# syntax=docker/dockerfile:1.7
FROM nvidia/cuda:11.7.1-devel-ubuntu22.04 AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends g++ libx11-6 libgomp1 libxcb1 libpng16-16 libgl1 libegl1 libglx0 libglvnd0 libjpeg-turbo8 libxdmcp6 libbsd0 libxau6 libmd0 libxext6 libvulkan1 libvulkan-dev vulkan-tools libglfw3-dev libdc1394-dev mesa-utils && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=insta360_deb cp /run/secrets/insta360_deb /tmp/insta360.deb && apt-get update && apt-get install -y /tmp/insta360.deb && rm /tmp/insta360.deb
COPY stitch360.cc /src/stitch360.cc
RUN g++ /src/stitch360.cc -O2 -std=c++17 -lMediaSDK -lpthread -Wl,--allow-shlib-undefined -o /usr/local/bin/stitch360

FROM nvidia/cuda:11.7.1-runtime-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip libx11-6 libgomp1 libxcb1 libpng16-16 libgl1 libegl1 libglx0 libglvnd0 libjpeg-turbo8 libxdmcp6 libbsd0 libxau6 libmd0 libxext6 libvulkan1 libglfw3 libdc1394-25 && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=insta360_deb cp /run/secrets/insta360_deb /tmp/insta360.deb && apt-get update && apt-get install -y /tmp/insta360.deb && rm /tmp/insta360.deb
COPY --from=build /usr/local/bin/stitch360 /usr/local/bin/stitch360
COPY requirements.txt /app/requirements.txt
RUN pip3 install --no-cache-dir -r /app/requirements.txt
COPY worker.py /app/worker.py
WORKDIR /app
CMD ["python3", "worker.py"]
