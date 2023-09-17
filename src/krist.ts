import req from 'axios';
import ws from 'ws';
import _ from 'lodash';

interface CommonMeta {
    metaname?: string;
    name?: string;

    username?: string;
    recipient?: string;
    return?: string;

    message?: string;
    error?: string;

    [misc: string]: string | undefined;
}

function parseCommonMeta(metadata: string): CommonMeta {
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

type Modify<T, R> = Omit<T, keyof R> & R;
namespace Krist {
    interface RawAddressStatus {
        isGuest: boolean,
        address: {
            address: string,
            balance: number,
            totalin: number,
            totalout: number,
            firstseen: string
        }
    }

    interface RawTransaction {
        id: number;
        from: string;
        to: string;
        value: number;
        time: string;
        metadata: string;
    }

    export type AddressStatus = Modify<RawAddressStatus["address"], { firstseen: Date }>

    type TransactionData = Modify<RawTransaction, {
        time: Date;

        metadata: CommonMeta;
        raw_metadata: string;
    }>;

    export class Transaction implements TransactionData {
        id!: number;
        from!: string;
        to!: string;
        value!: number;
        time!: Date;
        metadata!: CommonMeta;
        raw_metadata!: string;

        client: Client;

        constructor(rtx: RawTransaction, client: Client) {
            this.client = client;

            Object.assign(this, rtx, {
                time: new Date(rtx.time),

                metadata: parseCommonMeta(rtx.metadata),
                raw_metadata: rtx.metadata
            });
        }

        refund(meta?: CommonMeta, partialAmt?: number) {
            const returnLocation = this.metadata.return || this.from;

            return this.client.makeTransaction(returnLocation, partialAmt || this.value,
                Object.assign({}, meta));
        }
    }

    type TransactionHandler = (tx: Transaction) => void;

    export class Client {
        currKWS!: ws;
        currAddress?: AddressStatus;

        listeners: { type: string, listener: Function }[] = [];
        promises: { id: number, resolve: Function, reject: Function }[] = [];

        async connect(pkey?: string): Promise<ws> {
            const response = await req.post("https://krist.ceriat.net/ws/start", { privatekey: pkey });

            if (!response) throw new Error("Empty Krist start response");
            if (typeof response.data !== "object" ||
                response.data.ok !== true
            ) { throw new Error("Invalid Krist start response"); }

            const handle = this.currKWS = new ws(response.data.url);

            const connectTimeout = setTimeout(() => {
                if (handle && handle.readyState == 2) handle.close();
                throw new Error("Krist did not respond to hello");
            }, 5000);

            return await new Promise((resolve, reject) => {
                handle.on("message", msg => {
                    const message = JSON.parse(msg.toString());

                    switch (message.type) {
                        case "hello":
                            clearTimeout(connectTimeout);
                            handle.removeAllListeners("message");
                            this.setupClient()
                                .then(() => resolve(handle))
                                .catch(e => reject(e));

                            break;

                        default:
                            break;
                    }
                });

                handle.on("close", () => {
                    console.log("Krist WS closed, restarting..");
                    process.exit();
                });
            });
        }

        registerNameTXListener(name: string, listener: TransactionHandler) {
            this.listeners.push({
                type: "transaction", listener: (rtx: RawTransaction) => {
                    const tx = new Transaction(rtx, this);

                    // Verify that this transaction is directed at us
                    if (tx.to !== this.currAddress?.address) return;
                    if (tx.metadata.name !== name) return;

                    listener(tx);
                }
            });
        }

        makeTransaction(to: string, amt: number, meta: CommonMeta) {
            const metastr = Object.keys(meta).map(key => `${key}=${meta[key]}`).join(";");

            return this.makeAPIRequest("make_transaction", {
                to: to,
                amount: amt,
                metadata: metastr
            });
        }

        async refetchAddress() {
            const status = await this.makeAPIRequest("me") as RawAddressStatus;
            if (status.isGuest) this.currAddress = undefined;
            else {
                this.currAddress = Object.assign(status.address, { firstseen: new Date(status.address.firstseen) });
            }
        }

        private async setupClient() {
            this.setupHooks();

            await this.refetchAddress();
        }

        private idCounter = 0;
        private makeAPIRequest(type: string, data?: object) {
            return new Promise((resolve, reject) => {
                let id = ++this.idCounter;

                this.promises.push({
                    id: id,
                    resolve: resolve,
                    reject: reject
                });

                this.currKWS.send(JSON.stringify(_.merge({
                    type: type,
                    id: id
                }, data)));
            });
        }

        private emit(eventType: string, data: any) {
            this.listeners.forEach(({ type, listener }) => {
                if (type === eventType)
                    listener(data);
            });
        }

        private setupHooks() {
            this.currKWS.on("message", msg => {
                const message = JSON.parse(msg.toString());

                switch (message.type) {
                    case "event":
                        switch (message.event) {
                            case "transaction":
                                const tx = message.transaction;
                                this.emit("transaction", tx);
                                break;
                        }
                        break;

                    default:
                        if (message.id) {
                            let promise = _.find(this.promises, { id: message.id });

                            if (promise) {
                                if (message.ok) {
                                    promise.resolve(message);
                                } else {
                                    promise.reject(message);
                                }

                                _.remove(this.promises, { id: message.id });
                            }
                        }
                        break;
                }
            });
        }
    }
}

export = Krist;
