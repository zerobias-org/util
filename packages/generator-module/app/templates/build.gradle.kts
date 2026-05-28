plugins {
    id("<% if (isConnector) { %>zb.typescript-connector<% } else { %>zb.typescript<% } %>")
}
