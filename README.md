# LamedDB

LamedDB is a cloud-native database that adapts how it stores, serves, and streams data as usage changes. Applications use one API to write and query records, publish events, and subscribe to changes. A collection can change physical layout without changing application code.

The pilot is a TypeScript SDK and HTTP API for single-region workflows such as orders, tickets, and activity.

## Requirements

- Node.js 20 or newer

## Install

```bash
npm install
```

## Test

```bash
npm test
```

## Build

```bash
npm run build
```

Compiled output is written to `dist/`.

## Run

This commit is the project scaffold only. The HTTP server arrives with the first collections API. After that change, start it with:

```bash
npm run dev
```
