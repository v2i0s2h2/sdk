import { Buffer } from 'buffer/';
import { CanisterId } from './canisterId';
import { HttpAgent } from './http_agent';
import {
  QueryResponseStatus,
  RequestStatusResponse,
  RequestStatusResponseReplied,
  RequestStatusResponseStatus,
  SubmitResponse,
} from './http_agent_types';
import * as IDL from './idl';
import { RequestId, toHex as requestIdToHex } from './request_id';
import { BinaryBlob } from './types';

/**
 * An actor interface. An actor is an object containing only functions that will
 * return a promise. These functions are derived from the IDL definition.
 */
export type Actor = Record<string, (...args: unknown[]) => Promise<unknown>> & {
  __actorInterface(): Record<string, IDL.FuncClass>;
  __createCanister(options?: {
    maxAttempts?: number;
    throttleDurationInMSecs?: number;
  }): Promise<CanisterId>;
  __setCanisterId(cid: CanisterId): void;
  __canisterId(): string | undefined;
  __getAsset(path: string): Promise<Uint8Array>;
  __install(
    fields: {
      module: BinaryBlob;
      arg?: BinaryBlob;
    },
    options?: {
      maxAttempts?: number;
      throttleDurationInMSecs?: number;
    },
  ): Promise<void>;
};

export interface ActorConfig {
  canisterId?: string | CanisterId;
  httpAgent?: HttpAgent;
  maxAttempts?: number;
  throttleDurationInMSecs?: number;
}

declare const window: { icHttpAgent?: HttpAgent };
declare const global: { icHttpAgent?: HttpAgent };
declare const self: { icHttpAgent?: HttpAgent };

function getDefaultHttpAgent() {
  return typeof window === 'undefined'
    ? typeof global === 'undefined'
      ? typeof self === 'undefined'
        ? undefined
        : self.icHttpAgent
      : global.icHttpAgent
    : window.icHttpAgent;
}

// IDL functions can have multiple return values, so decoding always
// produces an array. Ensure that functions with single or zero return
// values behave as expected.
function decodeReturnValue(types: IDL.Type[], msg: BinaryBlob) {
  const returnValues = IDL.decode(types, Buffer.from(msg));
  switch (returnValues.length) {
    case 0:
      return undefined;
    case 1:
      return returnValues[0];
    default:
      return returnValues;
  }
}

const REQUEST_STATUS_RETRY_WAIT_DURATION_IN_MSECS = 500;
const DEFAULT_ACTOR_CONFIG: Partial<ActorConfig> = {
  maxAttempts: 30,
  throttleDurationInMSecs: REQUEST_STATUS_RETRY_WAIT_DURATION_IN_MSECS,
};

export type ActorConstructor = (config: ActorConfig) => Actor;

// Make an actor from an actor interface.
//
// Allows for one HTTP agent for the lifetime of the actor:
//
// ```
// const actor = makeActor(actorInterface)(httpAgent);
// const reply = await actor.greet();
// ```
//
// or using a different HTTP agent for the same actor if necessary:
//
// ```
// const actor = makeActor(actorInterface);
// const reply1 = await actor(httpAgent1).greet();
// const reply2 = await actor(httpAgent2).greet();
// ```
export function makeActorFactory(
  actorInterfaceFactory: (_: { IDL: typeof IDL }) => IDL.ServiceClass,
): ActorConstructor {
  const actorInterface = actorInterfaceFactory({ IDL });

  async function requestStatusAndLoop<T>(
    httpAgent: HttpAgent,
    requestId: RequestId,
    decoder: (response: RequestStatusResponseReplied) => T,
    attempts: number,
    maxAttempts: number,
    throttle: number,
  ): Promise<T> {
    const status = await httpAgent.requestStatus({ requestId });

    switch (status.status) {
      case RequestStatusResponseStatus.Replied: {
        return decoder(status);
      }

      case RequestStatusResponseStatus.Unknown:
      case RequestStatusResponseStatus.Pending:
        if (--attempts === 0) {
          throw new Error(
            `Failed to retrieve a reply for request after ${maxAttempts} attempts:\n` +
              `  Request ID: ${requestIdToHex(requestId)}\n` +
              `  Request status: ${status.status}\n`,
          );
        }

        // Wait a little, then retry.
        return new Promise(resolve => setTimeout(resolve, throttle)).then(() =>
          requestStatusAndLoop(httpAgent, requestId, decoder, attempts, maxAttempts, throttle),
        );

      case RequestStatusResponseStatus.Rejected:
        throw new Error(
          `Call was rejected:\n` +
            `  Request ID: ${requestIdToHex(requestId)}\n` +
            `  Reject code: ${status.reject_code}\n` +
            `  Reject text: ${status.reject_message}\n`,
        );
    }
  }

  return (config: ActorConfig) => {
    const { canisterId, maxAttempts, throttleDurationInMSecs, httpAgent } = {
      ...DEFAULT_ACTOR_CONFIG,
      ...config,
    } as Required<ActorConfig>;

    let cid =
      canisterId !== undefined
        ? typeof canisterId === 'string'
          ? CanisterId.fromText(canisterId)
          : canisterId
        : undefined;
    const actor: Actor = {
      __actorInterface() {
        return actorInterface._fields.reduce(
          (obj, entry) => ({ ...obj, [entry[0]]: entry[1] }),
          {},
        );
      },
      __canisterId() {
        return cid?.toHex();
      },
      async __getAsset(path: string) {
        const agent = httpAgent || getDefaultHttpAgent();
        if (!agent) {
          throw new Error('Cannot make call. httpAgent is undefined.');
        }
        if (!cid) {
          throw new Error('Cannot make call. Canister ID is undefined.');
        }

        return agent.retrieveAsset(cid, path);
      },
      __setCanisterId(newCid: CanisterId): void {
        cid = newCid;
      },
      async __createCanister(
        options: {
          maxAttempts?: number;
          throttleDurationInMSecs?: number;
        } = {},
      ): Promise<CanisterId> {
        const agent = httpAgent || getDefaultHttpAgent();
        if (!agent) {
          throw new Error('Cannot make call. httpAgent is undefined.');
        }

        // Resolve the options that can be used globally or locally.
        const effectiveMaxAttempts = options.maxAttempts?.valueOf() || 0;
        const effectiveThrottle = options.throttleDurationInMSecs?.valueOf() || 0;

        const { requestId, response } = await agent.createCanister();
        if (!response.ok) {
          throw new Error(
            [
              'Canister Creation failed:',
              `  Request ID: ${requestIdToHex(requestId)}`,
              `  HTTP status code: ${response.status}`,
              `  HTTP status text: ${response.statusText}`,
            ].join('\n'),
          );
        }

        return await requestStatusAndLoop(
          agent,
          requestId,
          status => {
            if (status.reply.canister_id === undefined) {
              throw new Error(
                'Canister Creation failed: Replica did not reply with a canister id.',
              );
            }
            return CanisterId.fromBlob(status.reply.canister_id);
          },
          effectiveMaxAttempts,
          effectiveMaxAttempts,
          effectiveThrottle,
        );
      },

      async __install(
        fields: {
          module: BinaryBlob;
          arg?: BinaryBlob;
        },
        options: {
          maxAttempts?: number;
          throttleDurationInMSecs?: number;
        } = {},
      ) {
        const agent = httpAgent || getDefaultHttpAgent();
        if (!agent) {
          throw new Error('Cannot make call. httpAgent is undefined.');
        }
        if (!cid) {
          throw new Error('Cannot make call. Canister ID is undefined.');
        }

        // Resolve the options that can be used globally or locally.
        const effectiveMaxAttempts = options.maxAttempts?.valueOf() || 0;
        const effectiveThrottle = options.throttleDurationInMSecs?.valueOf() || 0;

        const { requestId, response } = await agent.install(cid, fields);
        if (!response.ok) {
          throw new Error(
            [
              'Install failed:',
              `  Canister ID: ${cid.toHex()}`,
              `  Request ID: ${requestIdToHex(requestId)}`,
              `  HTTP status code: ${response.status}`,
              `  HTTP status text: ${response.statusText}`,
            ].join('\n'),
          );
        }

        return requestStatusAndLoop(
          agent,
          requestId,
          () => {},
          effectiveMaxAttempts,
          effectiveMaxAttempts,
          effectiveThrottle,
        );
      },
    } as Actor;

    for (const [methodName, func] of actorInterface._fields) {
      actor[methodName] = async (...args: any[]) => {
        const agent = httpAgent || getDefaultHttpAgent();
        if (!agent) {
          throw new Error('Cannot make call. httpAgent is undefined.');
        }
        if (!cid) {
          throw new Error('Cannot make call. Canister ID is undefined.');
        }

        const arg = IDL.encode(func.argTypes, args) as BinaryBlob;
        if (func.annotations.includes('query')) {
          const result = await agent.query(cid, { methodName, arg });

          switch (result.status) {
            case QueryResponseStatus.Rejected:
              throw new Error(
                `Query failed:\n` +
                  `  Status: ${result.status}\n` +
                  `  Message: ${result.reject_message}\n`,
              );

            case QueryResponseStatus.Replied:
              return decodeReturnValue(func.retTypes, result.reply.arg);
          }
        } else {
          const { requestId, response } = await agent.call(cid, { methodName, arg });

          if (!response.ok) {
            throw new Error(
              [
                'Call failed:',
                `  Method: ${methodName}(${args})`,
                `  Canister ID: ${cid.toHex()}`,
                `  Request ID: ${requestIdToHex(requestId)}`,
                `  HTTP status code: ${response.status}`,
                `  HTTP status text: ${response.statusText}`,
              ].join('\n'),
            );
          }

          return requestStatusAndLoop(
            agent,
            requestId,
            status => {
              if (status.reply.arg !== undefined) {
                return decodeReturnValue(func.retTypes, status.reply.arg);
              } else if (func.retTypes.length === 0) {
                return undefined;
              } else {
                throw new Error(
                  `Call was returned undefined, but type [${func.retTypes.join(',')}].`,
                );
              }
            },
            maxAttempts,
            maxAttempts,
            throttleDurationInMSecs,
          );
        }
      };
    }

    return actor;
  };
}