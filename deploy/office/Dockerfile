FROM public.ecr.aws/allotropia/libo-builders/wasm@sha256:264bd82999f88a1da4fec9c460f9e55a466251d71dbe27e759c43eb62928fd6b
USER root
RUN git clone --depth 1 --branch 4.0.10 https://github.com/emscripten-core/emsdk.git /opt/taskasaur-emsdk && /opt/taskasaur-emsdk/emsdk install 4.0.10 && /opt/taskasaur-emsdk/emsdk activate 4.0.10
ENV EMSDK=/opt/taskasaur-emsdk
RUN apt-get update && apt-get install -y --no-install-recommends gcc-12 g++-12 && rm -rf /var/lib/apt/lists/*
ENV CC_FOR_BUILD=gcc-12 CXX_FOR_BUILD=g++-12
