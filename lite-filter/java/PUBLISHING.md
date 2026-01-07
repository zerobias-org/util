# Publishing to Maven Central

This guide explains how to publish the `lite-filter` package to Maven Central under the `com.zerobias` group ID using the new Central Portal.

## Prerequisites

### 1. Create a Central Portal Account

1. Go to https://central.sonatype.com/
2. Sign up or log in (you can use your GitHub account)
3. Create a namespace for `com.zerobias`:
   - Click on "Namespaces" in the left menu
   - Click "Add Namespace"
   - Enter `com.zerobias`
   - Verify ownership via GitHub organization (easiest method)
4. Wait for namespace verification (usually quick if using GitHub verification)

### 2. Generate GPG Keys

Maven Central requires all artifacts to be signed with GPG.

#### Install GPG

**macOS:**
```bash
brew install gnupg
```

**Linux:**
```bash
sudo apt-get install gnupg  # Debian/Ubuntu
sudo yum install gnupg      # RHEL/CentOS
```

**Windows:**
Download from https://www.gnupg.org/download/

#### Generate a Key Pair

```bash
gpg --gen-key
```

Follow the prompts:
- Use your name and email (kmccarthy@zerobias.com)
- Choose a strong passphrase
- The default key type (RSA) is fine

#### List Your Keys

```bash
gpg --list-keys
```

Note your key ID (the 8-character hex string).

#### Publish Your Public Key

```bash
gpg --keyserver keyserver.ubuntu.com --send-keys YOUR_KEY_ID
gpg --keyserver keys.openpgp.org --send-keys YOUR_KEY_ID
gpg --keyserver pgp.mit.edu --send-keys YOUR_KEY_ID
```

### 3. Generate User Token

1. Log in to https://central.sonatype.com/
2. Click on your profile in the top right
3. Select "View Account"
4. Click "Generate User Token"
5. Copy the generated username and password

### 4. Configure Maven Settings

1. Copy the template file:
```bash
cp settings.xml.template ~/.m2/settings.xml
```

2. Edit `~/.m2/settings.xml` and replace:
   - `YOUR_SONATYPE_USERNAME` - Your generated token username
   - `YOUR_SONATYPE_PASSWORD` - Your generated token password
   - Make sure the server ID is `central` (not `ossrh`)

**Important:** The credentials should be the token username/password from the Central Portal, not your login credentials.

## Publishing Process

### 1. Prepare for Release

Update the version in `pom.xml` from `1.0.0-SNAPSHOT` to `1.0.0` (or your desired release version):

```xml
<version>1.0.0</version>
```

### 2. Run Tests

Ensure all tests pass before publishing:

```bash
cd /path/to/lite-filter/java
mvn clean test
```

### 3. Deploy to Maven Central

**Important:** The Central Portal does not support SNAPSHOT versions. You must use release versions only.

For release versions:

```bash
mvn clean deploy
```

This will:
1. Compile the code
2. Run tests
3. Generate source JAR
4. Generate Javadoc JAR
5. Sign all artifacts with GPG
6. Upload to Central Portal
7. Automatically publish to Maven Central (due to `autoPublish=true`)

You'll be prompted for your GPG passphrase during the signing step (or it will use the passphrase from settings.xml).

### 4. Verify the Release

After successful deployment:

1. Check your deployments at https://central.sonatype.com/publishing/deployments
2. Maven Central sync takes ~30 minutes to 2 hours
3. Verify at https://repo1.maven.org/maven2/com/zerobias/lite-filter/
4. Search at https://search.maven.org/search?q=g:com.zerobias

### 5. Post-Release

After successful release:

1. Update version in `pom.xml` to next SNAPSHOT version:
```xml
<version>1.0.1-SNAPSHOT</version>
```

2. Commit and push:
```bash
git add pom.xml
git commit -m "Release version 1.0.0"
git tag v1.0.0
git push origin main --tags
```

## Usage by Consumers

Once published, users can add your library to their projects:

### Maven

```xml
<dependency>
    <groupId>com.zerobias</groupId>
    <artifactId>lite-filter</artifactId>
    <version>1.0.0</version>
</dependency>
```

### Gradle

```groovy
implementation 'com.zerobias:lite-filter:1.0.0'
```

### Gradle (Kotlin DSL)

```kotlin
implementation("com.zerobias:lite-filter:1.0.0")
```

## Troublesoting

### GPG Signing Issues

If you get GPG signing errors:

```bash
# Make sure gpg-agent is running
gpgconf --launch gpg-agent

# Test signing
echo "test" | gpg --clearsign

# If you need to specify the GPG executable
mvn clean deploy -Dgpg.executable=gpg
```

### Authentication Failures

- Verify credentials in `~/.m2/settings.xml`
- Make sure you're using the token username/password from https://central.sonatype.com/usertoken
- Check that you're using the correct server ID (`central`)
- Verify your namespace `com.zerobias` is approved at https://central.sonatype.com/publishing/namespaces

### Deployment Hangs or Fails

- Ensure you have a stable internet connection
- Check Central Portal status
- Try deploying without auto-publish:
  ```xml
  <autoPublish>false</autoPublish>
  ```
  Then manually publish via https://central.sonatype.com/publishing/deployments

### Manual Publishing (if autoPublish=false)

1. Go to https://central.sonatype.com/publishing/deployments
2. Find your deployment
3. Review the artifacts
4. Click "Publish" to release to Maven Central

### SNAPSHOT Versions Not Supported

The Central Portal does not support SNAPSHOT versions. If you need to test your package:
1. Use a local Maven repository
2. Use a pre-release version number (e.g., `1.0.0-beta.1`)
3. Consider using GitHub Packages for snapshots

## Additional Resources

- [Central Portal Publishing Guide](https://central.sonatype.org/publish/publish-portal-maven/)
- [Maven GPG Plugin](https://maven.apache.org/plugins/maven-gpg-plugin/)
- [Central Publishing Maven Plugin](https://central.sonatype.org/publish/publish-portal-maven/)