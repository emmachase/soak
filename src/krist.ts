import { JSONCodec, JetStreamClient } from 'nats';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { KristTransaction } from 'krist';

type Modify<T, R> = Omit<T, keyof R> & R;

export interface CommonMeta {
    metaname?: string;
    name?: string;

    username?: string;
    recipient?: string;
    return?: string;

    message?: string;
    error?: string;

    [misc: string]: string | undefined;
}

export function parseCommonMeta(metadata: string | null): CommonMeta {
    if (!metadata) return {};

    const parts: CommonMeta = {};

    const metaParts = metadata.split(";");
    if (metaParts.length <= 0) return {};

    const nameMatches = /^(?:([a-z0-9-_]{1,32})@)?([a-z0-9]{1,64}\.kst)$/.exec(metaParts[0]);

    if (nameMatches) {
        if (nameMatches[1]) parts.metaname = nameMatches[1];
        if (nameMatches[2]) parts.name = nameMatches[2];

        parts.recipient = nameMatches[1] ? nameMatches[1] + "@" + nameMatches[2] : nameMatches[2];
    }

    for (let i = 0; i < metaParts.length; i++) {
        const metaPart = metaParts[i];
        const kv = metaPart.split("=", 2);

        if (i === 0 && nameMatches) continue;

        if (kv.length === 1) {
            parts[i.toString()] = kv[0];
        } else {
            parts[kv[0]] = kv.slice(1).join("=");
        }
    }

    return parts;
}

export function serializeCommonMeta(meta?: CommonMeta) {
    if (!meta) return undefined;

    return Object.keys(meta).map(key => `${key}=${meta[key]}`).join(";")
}

function sha256(digest: string): Uint8Array {
    return crypto.createHash("sha256").update(digest).digest();
}

function calculateTransactionUUID(sourceTx: KristTransaction, to: string) {
    const seed = `${sourceTx.id}.${to}`;
    const hash = sha256(seed);
    return uuidv4({ random: hash });
}

export interface TransactionRequest {
    to: string
    amount: number
    meta: string | undefined
}

const json = JSONCodec();
export async function publishTransaction(js: JetStreamClient, srcTx: KristTransaction, req: Modify<TransactionRequest, { meta: CommonMeta | undefined }>) {
    const uuid = calculateTransactionUUID(srcTx, req.to);
    const meta = req.meta && serializeCommonMeta(req.meta);

    console.log("Publishing transaction:", req);

    return await js.publish("soak.txs.outgoing", json.encode({ ...req, meta }), {
        msgID: uuid,
    })
}

export async function refundTransaction(js: JetStreamClient, srcTx: KristTransaction, meta?: CommonMeta, partialAmt?: number) {
    const metadata = parseCommonMeta(srcTx.metadata);
    const returnLocation = metadata.return || srcTx.from;
    const refundAmount = partialAmt || srcTx.value;

    console.log(`Refunding ${refundAmount}KST of transaction:`, srcTx);
    
    return publishTransaction(js, srcTx, {
        to: returnLocation,
        amount: refundAmount,
        meta
    })
}
