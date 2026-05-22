import { createRequire } from "node:module";
import type { StorageDriver } from "./driver.js";

const _require = createRequire(import.meta.url);

export interface DynamoDBStorageConfig {
  tableName?: string;
  region?: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export class DynamoDBStorage implements StorageDriver {
  private client: any;
  private tableName: string;

  constructor(private config: DynamoDBStorageConfig = {}) {
    this.tableName = config.tableName ?? "agentium_kv";

    let DynamoDBClient: any;
    try {
      const sdk = _require("@aws-sdk/client-dynamodb");
      DynamoDBClient = sdk.DynamoDBClient;
    } catch {
      throw new Error(
        "@aws-sdk/client-dynamodb is required for DynamoDBStorage. Install it: npm install @aws-sdk/client-dynamodb",
      );
    }

    const clientOpts: Record<string, unknown> = {};
    if (config.region) clientOpts.region = config.region;
    if (config.endpoint) clientOpts.endpoint = config.endpoint;
    if (config.credentials) clientOpts.credentials = config.credentials;

    this.client = new DynamoDBClient(clientOpts);
  }

  private cmd(name: string, input: any): Promise<any> {
    const sdk = _require("@aws-sdk/client-dynamodb");
    const CommandClass = sdk[name];
    return this.client.send(new CommandClass(input));
  }

  async initialize(): Promise<void> {
    try {
      await this.cmd("DescribeTableCommand", { TableName: this.tableName });
    } catch (err: any) {
      if (err.name === "ResourceNotFoundException") {
        await this.cmd("CreateTableCommand", {
          TableName: this.tableName,
          KeySchema: [
            { AttributeName: "namespace", KeyType: "HASH" },
            { AttributeName: "key", KeyType: "RANGE" },
          ],
          AttributeDefinitions: [
            { AttributeName: "namespace", AttributeType: "S" },
            { AttributeName: "key", AttributeType: "S" },
          ],
          BillingMode: "PAY_PER_REQUEST",
        });
        await this.cmd("DescribeTableCommand", { TableName: this.tableName });
      } else {
        throw err;
      }
    }
  }

  async get<T>(namespace: string, key: string): Promise<T | null> {
    const result = await this.cmd("GetItemCommand", {
      TableName: this.tableName,
      Key: {
        namespace: { S: namespace },
        key: { S: key },
      },
    });
    if (!result.Item?.value?.S) return null;
    return JSON.parse(result.Item.value.S) as T;
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    await this.cmd("PutItemCommand", {
      TableName: this.tableName,
      Item: {
        namespace: { S: namespace },
        key: { S: key },
        value: { S: JSON.stringify(value) },
        updatedAt: { S: new Date().toISOString() },
      },
    });
  }

  async delete(namespace: string, key: string): Promise<void> {
    await this.cmd("DeleteItemCommand", {
      TableName: this.tableName,
      Key: {
        namespace: { S: namespace },
        key: { S: key },
      },
    });
  }

  async list<T>(namespace: string, prefix?: string): Promise<Array<{ key: string; value: T }>> {
    let expression = "namespace = :ns";
    const values: Record<string, any> = { ":ns": { S: namespace } };

    if (prefix) {
      expression += " AND begins_with(#k, :prefix)";
      values[":prefix"] = { S: prefix };
    }

    const result = await this.cmd("QueryCommand", {
      TableName: this.tableName,
      KeyConditionExpression: expression,
      ExpressionAttributeValues: values,
      ...(prefix ? { ExpressionAttributeNames: { "#k": "key" } } : {}),
    });

    return (result.Items ?? []).map((item: any) => ({
      key: item.key.S as string,
      value: JSON.parse(item.value.S) as T,
    }));
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}
