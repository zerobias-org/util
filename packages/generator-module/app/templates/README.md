# <%= className %> Module

## Authentication and authorization

<% if (isConnector) { %>
### Connect using credentials:

```typescript
import { new<%= className %>, ConnectionProfile } from '<%= modulePackage %>';

const api = new<%= className %>();
const profile = new ConnectionProfile(/* ... */);
await api.connect(profile);
```
<% } %>

## Usage

```typescript
import { new<%= className %> } from '<%= modulePackage %>';

const api = new<%= className %>();
```

## Test

This module is built and tested via Gradle + zbb. From the repo root:

```bash
./gradlew :<%= moduleName.split('-').join(':') %>:build   # validate → generate → compile → test → buildImage

# Local test modes (run from this module dir)
zbb test --slot local         # unit tests
zbb testDirect --slot local   # e2e direct (in-process)
zbb testDocker --slot local   # e2e docker (container)
zbb testHub --slot local      # e2e hub (full stack)
zbb gate --slot local         # full gate (writes gate-stamp.json — commit it)
```
