
# Secrets Manager

Hub Secrets Manager supports the following secrets providers:

- environment variables
- file system
- Hashicorp Vault
- AWS Secrets Manager
 
## Caching
The secrets manager will cache results on a timeout that resets on `list` calls. This defaults to 5 minutes and can be modified with the `CACHE_TIMEOUT_SECONDS` environment variable.

## Writable Configuration

To configure a writable secret, the environment variable `WRITABLE_SECRET` should be set to a full secret path, i.e. `aws.auditmation`.

# Backing stores

## Environment Variables

This secrets manager is automatically enabled and nothing needs to be done. It will present all environment variables as secrets.

## File System

This secrets manager is enabled by setting `FILE_SECRET_ROOT`. This should be a fully-qualified path to a location where secrets can be found on the file system. Writability is determined by the filesystem permissions.

### Limitations

Any `file` which is found will only be returned if it meets the following criteria:

- is of the format `file.extension`
- has an extension of `json`, `yaml`, or `yml`
- a file node will NOT present with its extension. i.e. - The file `<cwd>/foo/bar/baz.json` will have the path `file.foo.bar.baz` returned from the secrets manager

## Hashicorp Vault

To enable fetching secrets from Hashicorp Vault, two environment variables must be set:

- `VAULT_ADDR`: a URL to the Vault instance
- `VAULT_TOKEN`: the token to use to access the Vault instance
- `VAULT_NAMESPACE`: the optional namespace to use to connect to the Vault instance

## AWS Secrets Manager

- `AWS_SECRET_ACCESS_KEY`: the AWS access key to use
- `AWS_ACCESS_KEY_ID`: the ID of the AWS access key to use
- `AWS_REGION` or `AWS_DEFAULT_REGION`: the AWS region to connect to
- `AWS_ENDPOINT`: hostname for the AWS endpoint to use

Either `AWS_ENDPOINT` or one of the region variables may be provided. Both are not required.
