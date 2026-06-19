FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv fonts-dejavu-core fontconfig && rm -rf /var/lib/apt/lists/* && fc-cache -f
RUN python3 -m venv /venv && /venv/bin/pip install --no-cache-dir rembg[cpu]
RUN /venv/bin/python -c "from rembg import new_session; new_session('silueta')"
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p data output
EXPOSE 5001
ENV RUN_SERVER=true PORT=5001 PATH="/venv/bin:$PATH"
CMD ["node", "server.js"]
