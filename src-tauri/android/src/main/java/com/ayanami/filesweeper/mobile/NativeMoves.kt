package com.ayanami.filesweeper.mobile

import java.io.File
import java.io.IOException

/** Kernel-level no-replace commit shared by recycle, restore, rename and copy. */
internal object NativeMoves {
    @JvmStatic external fun moveNoReplace(source: String, destination: String): String?
    fun move(source: File, destination: File) {
        val error = moveNoReplace(source.absolutePath, destination.absolutePath)
        if (error != null) throw IOException(error)
    }
}
