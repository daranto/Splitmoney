FROM python:3.12-slim

WORKDIR /app

ENV PORT=8080
ENV SPLITMONEY_DATA_DIR=/data

COPY . .

RUN mkdir -p /data

EXPOSE 8080

CMD ["python", "server.py"]
