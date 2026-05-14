package com.zerobias.codegen;

/**
 * Empty placeholder so the `test` task has Java source. The real unit tests
 * run via the `mochaUnit` Exec task wired in build.gradle — without this
 * file, the TestNG `test` task is state.noSource=true and the monorepo
 * gate reports "skipped" instead of "passed".
 */
public class MochaPlaceholder {}
