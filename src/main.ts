import * as core from '@actions/core'
import * as cache from '@actions/cache'
import * as exec from '@actions/exec'
import * as fs from 'fs/promises'
import { existsSync, BigIntStats } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getInput, debugLocalInput } from './input'
import * as util from './util'
import { MtimeJson } from './json'
import { promisify } from 'util'
const nanoutimes = require(`../lib/node-v${process.versions.modules}-darwin-${os.arch()}/nanoutimes.node`)

main()

async function main() {
  try {
    const debugLocal = await debugLocalInput()
    if (debugLocal) {
      util.fakeCache(cache)
    }
    const runnerOs = process.env['RUNNER_OS']
    if (runnerOs != 'macOS') {
      throw new Error(`host is not macOS: ${runnerOs}`)
    }
    const input = getInput()
    core.info('> inputs')
    Object.entries(input).forEach(([key, value]) => {
      core.info(`${key}: ${value}`)
    })
    core.info('')
    const tempDirectory = path.join(process.env['RUNNER_TEMP']!, 'irgaly-xcode-cache')
    const derivedDataDirectory = await input.getDerivedDataDirectory()
    const derivedDataRestored = await restoreDerivedData(
      derivedDataDirectory,
      tempDirectory,
      input.key,
      input.restoreKeys,
      input.verbose
    )
    const sourcePackagesDirectory = await input.getSourcePackagesDirectory()
    if (sourcePackagesDirectory == null) {
      core.info(`SourcePackages directory not found, skip restoring SourcePackages`)
    } else {
      await restoreSourcePackages(
        sourcePackagesDirectory,
        tempDirectory,
        await input.getSwiftpmCacheKey(),
        input.swiftpmCacheRestoreKeys,
        input.verbose
      )
    }
    if (!derivedDataRestored) {
      core.info(`Skipped restoring mtime because of DerivedData is not restored`)
    } else {
      await restoreMtime(
        derivedDataDirectory,
        input.restoreMtimeTargets,
        input.verbose
      )
    }
    if (!debugLocal && existsSync(tempDirectory)) {
      core.info(`clean up: remove temporary directory: ${tempDirectory}`)
      await fs.rm(tempDirectory, { recursive: true, force: true })
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  }
}

async function restoreDerivedData(
  derivedDataDirectory: string,
  tempDirectory: string,
  key: string,
  restoreKeys: string[],
  verbose: boolean
): Promise<boolean> {
  const tar = path.join(tempDirectory, 'DerivedData.tar')
  core.info(`DerivedData.tar cache key:\n${key}\nrestoreKeys:\n${restoreKeys.join('\n')}`)
  const restoreKey = await cache.restoreCache([tar], key, restoreKeys)
  const restored = (restoreKey != undefined)
  if (!restored) {
    core.info('DerivedData cache not found')
  } else {
    core.info(`DerivedData restored with cache key: ${restoreKey}`)
    core.saveState('deriveddata-restorekey', restoreKey)
    const parent = path.dirname(derivedDataDirectory)
    await fs.mkdir(parent, { recursive: true })
    let args = ['-xf', tar, '-C', path.dirname(derivedDataDirectory)]
    if (verbose) {
      args = ['-v', ...args]
      core.startGroup('Unpack DerivedData.tar')
      await exec.exec('tar', ['--version'])
    }
    await exec.exec('tar', args)
    if (verbose) {
      core.endGroup()
    }
    core.info(`DerivedData has restored from cache: ${derivedDataDirectory}`)
  }
  return restored
}

async function restoreSourcePackages(
  sourcePackagesDirectory: string,
  tempDirectory: string,
  key: string,
  restoreKeys: string[],
  verbose: boolean
): Promise<boolean> {
  core.info(`SourcePackages.tar cache key:\n${key}\nrestoreKeys:\n${restoreKeys.join('\n')}`)
  const tar = path.join(tempDirectory, 'SourcePackages.tar')
  const restoreKey = await cache.restoreCache([tar], key, restoreKeys)
  const restored = (restoreKey != undefined)
  if (!restored) {
    core.info('SourcePackages cache not found')
  } else {
    core.info(`SourcePackages restored with cache key: ${restoreKey}`)
    core.saveState('sourcepackages-restorekey', restoreKey)
    const parent = path.dirname(sourcePackagesDirectory)
    await fs.mkdir(parent, { recursive: true })
    let args = ['-xf', tar, '-C', path.dirname(sourcePackagesDirectory)]
    if (verbose) {
      args = ['-v', ...args]
      core.startGroup('Unpack SourcePackages.tar')
      await exec.exec('tar', ['--version'])
    }
    await exec.exec('tar', args)
    if (verbose) {
      core.endGroup()
    }
    core.info(`SourcePackages has restored from cache: ${sourcePackagesDirectory}`)
  }
  return restored
}

async function restoreMtime(
  derivedDataDirectory: string,
  restoreMtimeTargets: string[],
  verbose: boolean
) {
  let changed = 0
  let skipped: string[] = []
  const jsonFile = path.join(derivedDataDirectory, 'xcode-cache-mtime.json')
  let json = null
  try {
    json = await fs.readFile(jsonFile, 'utf8')
  } catch (error) {
    core.info(`xcode-cache-mtime.json not found: ${jsonFile}`)
  }
  if (json != null) {
    const files = JSON.parse(json) as MtimeJson[]
    core.info(`restore mtime from ${jsonFile}`)
    if (verbose) {
      core.startGroup('Restored files')
    }
    for (const item of files) {
      let stat: BigIntStats | null = null
      try {
        stat = await fs.stat(item.path, {bigint: true})
      } catch (error) {
        // file not exist
        // do nothing
      }
      if (stat != null) {
        const fileMtime = stat.mtimeNs.toString()
        const cacheMtime = item.time.replace('.', '')
        if (fileMtime == cacheMtime) {
          if (verbose) {
            skipped.push(`mtime not changed : ${item.path}`)
          }
        } else {
          let sha256 = ''
          if (stat.isDirectory()) {
            sha256 = await util.calculateDirectoryHash(item.path)
          } else {
            sha256 = await util.calculateHash(item.path)
          }
          if (sha256 != item.sha256) {
            if (verbose) {
              skipped.push(`contents changed : ${item.path}`)
            }
          } else {
            if (verbose) {
              core.info(`=> ${item.time} : ${item.path}`)
            }
            const [second, nano] = item.time.split('.').map(v => Number(v))
            nanoutimes.utimesSync(item.path, second, nano, second, nano)
            changed++
          }
        }
      }
    }
    if (verbose) {
      core.endGroup()
      core.startGroup('Skipped files')
      skipped.forEach (v => {
        core.info(v)
      })
      core.endGroup()
    }
    core.info(`Restored ${changed} files.`)
  }
}
