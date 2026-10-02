# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# web-code-reader 镜像（06-platform P14 / P3 路径 C）
#
# 构建：
#   docker build -t web-code-reader .
#
# 运行（把本机目录**只读**挂进容器）：
#   docker run --rm -p 8787:8787 -v <本机目录>:/work:ro web-code-reader
#   然后浏览器打开 http://127.0.0.1:8787 ，项目路径填 /work/<本机目录名>
#
# 三件事必须记住：
# 1. 容器内监听 0.0.0.0（默认 HOST=0.0.0.0，否则宿主访问不到）；
# 2. 数据只落 /data（索引快照 / projects.json / runtime.json），可用 -v wcr-data:/data 持久化；
# 3. 被读目录用 `:ro` 挂载：容器进程物理上写不了它。
#    注意 Windows 下 bind mount 的权限语义弱于 Linux，`ro` 不总是「物理写不了」，
#    这种情况下由工具自身的只读承诺（不写被读目录）兜底。
# ---------------------------------------------------------------------------

FROM node:22-bookworm AS build
WORKDIR /app

# tree-sitter 的原生模块（backend 依赖）需要编译工具链
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# 先只拷清单，让依赖层可复用（改源码不必重装依赖）
COPY package.json package-lock.json ./
COPY backend/package.json backend/package-lock.json ./backend/
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm run install:all

# 再拷源码并构建前端产物
COPY shared ./shared
COPY backend ./backend
COPY frontend ./frontend
RUN npm run build

FROM node:22-bookworm AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    READER_DATA_DIR=/data
WORKDIR /app

# 运行时只带：后端（含 backend/node_modules，tree-sitter 原生模块与 tsx 都在里面）、
# 前端产物、共享类型。前端源码与构建工具不进镜像。
COPY --from=build /app/backend ./backend
COPY --from=build /app/frontend/dist ./frontend/dist
COPY --from=build /app/shared ./shared
COPY package.json ./

RUN useradd --create-home --uid 10001 reader \
  && mkdir -p /data \
  && chown -R reader:reader /data /app
USER reader

VOLUME /data
EXPOSE 8787
WORKDIR /app/backend

# 与 `npm start` 同一份 TypeScript 源码，用 tsx 直接跑（不产出额外构建物）
CMD ["node", "--import", "tsx", "src/server.ts"]
