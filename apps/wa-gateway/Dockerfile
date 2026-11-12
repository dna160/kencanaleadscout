# syntax=docker/dockerfile:1
# wa-gateway (Kabar Pesanan PRD §10). Static Go binary on distroless.
FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/wa-gateway .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/wa-gateway /wa-gateway
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/wa-gateway"]
