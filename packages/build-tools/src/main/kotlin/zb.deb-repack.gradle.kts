// zb.deb-repack — marker plugin for modules that build debs without a
// `zb.typescript-*` convention plugin (i.e., OS-level packages like
// shared, os, os-aws, os-hyperv).
//
// Applying `id("zb.deb-repack")` brings the build-tools jar onto the
// module's buildscript classpath so it can `import
// com.zerobias.buildtools.appliance.repackDebDeterministic` and call
// `project.repackDebDeterministic(deb)` from a `doLast` block on its
// own Deb task.
//
// No tasks, extensions, or configuration — this plugin's only job is
// classpath delivery. The Kotlin code itself lives in DebRepack.kt;
// see that file for what the function does.
