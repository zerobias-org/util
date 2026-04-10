package com.zerobias.buildtools.monorepo

import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters

/**
 * Build service that serializes prepublish-standalone across parallel
 * subprojects.
 *
 * `prepublish-standalone.sh` mutates `package.json` in place (replaces
 * workspace deps with concrete tarball references), so two npmPack tasks
 * running concurrently in different subprojects can race on each other's
 * package.json reads. The fix is a max-1 BuildService that npmPack tasks
 * acquire for the brief window of:
 *
 *   prepublish-standalone → npm pack → restore
 *
 * Other parts of dockerBuild (context prep, docker build itself) run
 * concurrently — only the lock window is serial.
 */
abstract class PrepublishLockService : BuildService<BuildServiceParameters.None>
