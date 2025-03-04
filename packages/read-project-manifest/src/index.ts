import { promises as fs, Stats } from 'fs'
import path from 'path'
import { PnpmError } from '@pnpm/error'
import { ProjectManifest } from '@pnpm/types'
import { writeProjectManifest } from '@pnpm/write-project-manifest'
import readYamlFile from 'read-yaml-file'

import detectIndent from 'detect-indent'
import equal from 'fast-deep-equal'
import isWindows from 'is-windows'
import sortKeys from 'sort-keys'
import {
  readJson5File,
  readJsonFile,
} from './readFile'

type WriteProjectManifest = (manifest: ProjectManifest, force?: boolean) => Promise<void>

export async function safeReadProjectManifestOnly (projectDir: string) {
  try {
    return await readProjectManifestOnly(projectDir)
  } catch (err: any) { // eslint-disable-line
    if ((err as NodeJS.ErrnoException).code === 'ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND') {
      return null
    }
    throw err
  }
}

export async function readProjectManifest (projectDir: string): Promise<{
  fileName: string
  manifest: ProjectManifest
  writeProjectManifest: WriteProjectManifest
}> {
  const result = await tryReadProjectManifest(projectDir)
  if (result.manifest !== null) {
    return result as {
      fileName: string
      manifest: ProjectManifest
      writeProjectManifest: WriteProjectManifest
    }
  }
  throw new PnpmError('NO_IMPORTER_MANIFEST_FOUND',
    `No package.json (or package.yaml, or package.json5) was found in "${projectDir}".`)
}

export async function readProjectManifestOnly (projectDir: string): Promise<ProjectManifest> {
  const { manifest } = await readProjectManifest(projectDir)
  return manifest
}

export async function tryReadProjectManifest (projectDir: string): Promise<{
  fileName: string
  manifest: ProjectManifest | null
  writeProjectManifest: WriteProjectManifest
}> {
  try {
    const manifestPath = path.join(projectDir, 'package.json')
    const { data, text } = await readJsonFile(manifestPath)
    return {
      fileName: 'package.json',
      manifest: data,
      writeProjectManifest: createManifestWriter({
        ...detectFileFormatting(text),
        initialManifest: data,
        manifestPath,
      }),
    }
  } catch (err: any) { // eslint-disable-line
    if (err.code !== 'ENOENT') throw err
  }
  try {
    const manifestPath = path.join(projectDir, 'package.json5')
    const { data, text } = await readJson5File(manifestPath)
    return {
      fileName: 'package.json5',
      manifest: data,
      writeProjectManifest: createManifestWriter({
        ...detectFileFormatting(text),
        initialManifest: data,
        manifestPath,
      }),
    }
  } catch (err: any) { // eslint-disable-line
    if (err.code !== 'ENOENT') throw err
  }
  try {
    const manifestPath = path.join(projectDir, 'package.yaml')
    const manifest = await readPackageYaml(manifestPath)
    return {
      fileName: 'package.yaml',
      manifest,
      writeProjectManifest: createManifestWriter({ initialManifest: manifest, manifestPath }),
    }
  } catch (err: any) { // eslint-disable-line
    if (err.code !== 'ENOENT') throw err
  }
  if (isWindows()) {
    // ENOTDIR isn't used on Windows, but pnpm expects it.
    let s: Stats | undefined
    try {
      s = await fs.stat(projectDir)
    } catch (err: any) { // eslint-disable-line
      // Ignore
    }
    if ((s != null) && !s.isDirectory()) {
      const err = new Error(`"${projectDir}" is not a directory`)
      err['code'] = 'ENOTDIR'
      throw err
    }
  }
  const filePath = path.join(projectDir, 'package.json')
  return {
    fileName: 'package.json',
    manifest: null,
    writeProjectManifest: async (manifest: ProjectManifest) => writeProjectManifest(filePath, manifest),
  }
}

function detectFileFormatting (text: string) {
  return {
    indent: detectIndent(text).indent,
    insertFinalNewline: text.endsWith('\n'),
  }
}

export async function readExactProjectManifest (manifestPath: string) {
  const base = path.basename(manifestPath).toLowerCase()
  switch (base) {
  case 'package.json': {
    const { data, text } = await readJsonFile(manifestPath)
    return {
      manifest: data,
      writeProjectManifest: createManifestWriter({
        ...detectFileFormatting(text),
        initialManifest: data,
        manifestPath,
      }),
    }
  }
  case 'package.json5': {
    const { data, text } = await readJson5File(manifestPath)
    return {
      manifest: data,
      writeProjectManifest: createManifestWriter({
        ...detectFileFormatting(text),
        initialManifest: data,
        manifestPath,
      }),
    }
  }
  case 'package.yaml': {
    const manifest = await readPackageYaml(manifestPath)
    return {
      manifest,
      writeProjectManifest: createManifestWriter({ initialManifest: manifest, manifestPath }),
    }
  }
  }
  throw new Error(`Not supported manifest name "${base}"`)
}

async function readPackageYaml (filePath: string) {
  try {
    return await readYamlFile<ProjectManifest>(filePath)
  } catch (err: any) { // eslint-disable-line
    if (err.name !== 'YAMLException') throw err
    err.message = `${err.message as string}\nin ${filePath}`
    err.code = 'ERR_PNPM_YAML_PARSE'
    throw err
  }
}

function createManifestWriter (
  opts: {
    initialManifest: ProjectManifest
    indent?: string | number | undefined
    insertFinalNewline?: boolean
    manifestPath: string
  }
): (WriteProjectManifest) {
  let initialManifest = normalize(opts.initialManifest)
  return async (updatedManifest: ProjectManifest, force?: boolean) => {
    updatedManifest = normalize(updatedManifest)
    if (force === true || !equal(initialManifest, updatedManifest)) {
      await writeProjectManifest(opts.manifestPath, updatedManifest, {
        indent: opts.indent,
        insertFinalNewline: opts.insertFinalNewline,
      })
      initialManifest = normalize(updatedManifest)
      return Promise.resolve(undefined)
    }
    return Promise.resolve(undefined)
  }
}

const dependencyKeys = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
])

function normalize (manifest: ProjectManifest) {
  manifest = JSON.parse(JSON.stringify(manifest))
  const result = {}

  for (const key of Object.keys(manifest)) {
    if (!dependencyKeys.has(key)) {
      result[key] = manifest[key]
    } else if (Object.keys(manifest[key]).length !== 0) {
      result[key] = sortKeys(manifest[key])
    }
  }

  return result
}
