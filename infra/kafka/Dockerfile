# Single-node Kafka (KRaft, no ZooKeeper) for a Render private service.
#
# Same broker as the local docker-compose one, plus a small entrypoint that
# advertises the service's private-network hostname (Render assigns it; the
# Blueprint passes it in as KAFKA_INTERNAL_HOST).
FROM confluentinc/cp-kafka:7.7.1

# Render mounts the persistent disk owned by root; the image's default
# "appuser" could not write to it. The broker is only reachable on Render's
# private network.
USER root

COPY infra/kafka/render-entrypoint.sh /usr/local/bin/render-entrypoint.sh
RUN chmod 0755 /usr/local/bin/render-entrypoint.sh

EXPOSE 9092
ENTRYPOINT ["/usr/local/bin/render-entrypoint.sh"]
