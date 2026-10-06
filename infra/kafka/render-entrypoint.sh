#!/bin/bash
# Entrypoint for Kafka on Render.
#
# Clients must reach the broker at the address it advertises, so that address
# is the service's private hostname. Render only knows it at deploy time, so
# it arrives as an env var and is spliced in here.
set -euo pipefail

: "${KAFKA_INTERNAL_HOST:?KAFKA_INTERNAL_HOST must be set (render.yaml passes the service host)}"
: "${KAFKA_LOG_DIRS:?KAFKA_LOG_DIRS must be set}"

export KAFKA_ADVERTISED_LISTENERS="PLAINTEXT://${KAFKA_INTERNAL_HOST}:9092"

# The disk is mounted one level up: a disk's root holds lost+found, which
# Kafka would try to load as a topic partition and refuse to start.
mkdir -p "${KAFKA_LOG_DIRS}"

exec /etc/confluent/docker/run
