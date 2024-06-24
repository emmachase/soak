import { ConsumerConfig, JetStreamManager, StreamConfig } from "nats";

export async function createOrUpdateConsumer(jsm: JetStreamManager, stream: string, config: ConsumerConfig & { durable_name: string }) {
    try {
        return await jsm.consumers.add(stream, config);
    } catch (e) {
        return await jsm.consumers.update(stream, config.durable_name, config);
    }
}

export async function createOrUpdateStream(jsm: JetStreamManager, config: Partial<StreamConfig> & { name: string }) {
    try {
        return await jsm.streams.add(config);
    } catch (e) {
        return await jsm.streams.update(config.name, config);
    }
}
