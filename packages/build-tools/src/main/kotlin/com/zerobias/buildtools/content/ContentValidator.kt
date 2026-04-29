package com.zerobias.buildtools.content

import com.zerobias.buildtools.content.validators.VendorValidator
import org.gradle.api.Project
import java.io.File

/**
 * Backward-compatibility shim. Replaced by the validators catalog at
 * com/zerobias/buildtools/content/validators/.
 *
 * New code should import the specific validator directly:
 *
 *     import com.zerobias.buildtools.content.validators.VendorValidator
 *     extra["contentValidator"] = VendorValidator::validate
 *
 * This object remains so external callers (any consumer that imported
 * `ContentValidator.validate(projectDir)` directly before the catalog
 * existed) keep working. Internally `zb.content.validateContent` now
 * routes through the catalog.
 */
@Deprecated(
    message = "Use com.zerobias.buildtools.content.validators.VendorValidator (or another validator from the catalog).",
    replaceWith = ReplaceWith(
        "VendorValidator.validate(project)",
        "com.zerobias.buildtools.content.validators.VendorValidator",
    )
)
object ContentValidator {

    data class Result(val code: String)

    /** Forwards to [VendorValidator.validateProjectDir]. Same full schema
     *  check as before the catalog refactor. */
    fun validate(projectDir: File): Result {
        val code = VendorValidator.validateProjectDir(projectDir)
        return Result(code)
    }

    /** Preferred entrypoint when a [Project] is available. Forwards to the
     *  catalog. */
    fun validate(project: Project) = VendorValidator.validate(project)
}
