import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { API_URL } from './config.js';

function versionParts(value) {
  return String(value ?? '')
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isNewer(candidate, current) {
  const next = versionParts(candidate);
  const now = versionParts(current);
  for (let index = 0; index < Math.max(next.length, now.length); index += 1) {
    const a = next[index] ?? 0;
    const b = now[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

export async function checkForUpdate(currentVersion, apiUrl = API_URL) {
  if (!apiUrl) return null;
  const response = await fetch(`${apiUrl}/api/releases/latest`, {
    headers: { 'cache-control': 'no-store' },
  });
  if (!response.ok) throw new Error('Could not check for updates.');
  const data = await response.json().catch(() => ({}));
  const release = data.release;
  if (!release?.version || !release?.downloadUrl || !release?.sha256) return null;
  if (!isNewer(release.version, currentVersion)) return null;
  return release;
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function downloadUpdate(release, directory, onProgress = () => {}) {
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `Aegis-Control-${release.version}.exe`);

  try {
    const info = await stat(filePath);
    if (info.size === release.size && (await hashFile(filePath)) === release.sha256) {
      onProgress(100);
      return filePath;
    }
  } catch {
    // Not downloaded yet.
  }

  const response = await fetch(release.downloadUrl, { headers: { 'cache-control': 'no-store' } });
  if (!response.ok || !response.body) throw new Error('Could not download the update.');

  const total = Number(release.size) || Number(response.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  const output = createWriteStream(filePath);
  let received = 0;

  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      received += buffer.length;
      if (!output.write(buffer)) {
        await new Promise((resolve) => output.once('drain', resolve));
      }
      if (total) onProgress(Math.min(99, Math.round((received / total) * 100)));
    }
    await new Promise((resolve, reject) => {
      output.end(resolve);
      output.on('error', reject);
    });
  } catch (error) {
    output.destroy();
    await rm(filePath, { force: true });
    throw new Error(`Could not download the update: ${error.message}`);
  }

  if (Number(release.size) && received !== Number(release.size)) {
    await rm(filePath, { force: true });
    throw new Error('The update download was incomplete. Try again.');
  }
  if (hash.digest('hex') !== release.sha256) {
    await rm(filePath, { force: true });
    throw new Error('The update file failed its integrity check. Try again.');
  }

  onProgress(100);
  return filePath;
}

function vbQuote(value) {
  return String(value).replace(/"/g, '""');
}

/**
 * The portable exe unpacks itself and runs from a temp folder, so the running
 * app cannot overwrite the file it was started from. A wscript-hosted VBScript
 * waits for both processes to exit, copies the verified download over the old
 * file and launches the new version.
 *
 * wscript.exe is a GUI-subsystem program. Unlike cmd.exe or powershell.exe it
 * cannot create a console window, even when spawned detached, so the helper
 * and the relaunched app are completely console-free.
 */
export function buildUpdateScript({ source, target }) {
  return [
    'Option Explicit',
    'Dim fso, shell, source, target, i, copied, outFile, errFile',
    `source = "${vbQuote(source)}"`,
    `target = "${vbQuote(target)}"`,
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set shell = CreateObject("WScript.Shell")',
    'WScript.Sleep 2500',
    'copied = False',
    'For i = 1 To 90',
    '  On Error Resume Next',
    '  Err.Clear',
    '  fso.CopyFile source, target, True',
    '  If Err.Number = 0 Then',
    '    copied = True',
    '    On Error GoTo 0',
    '    Exit For',
    '  End If',
    '  Err.Clear',
    '  On Error GoTo 0',
    '  WScript.Sleep 1000',
    'Next',
    'If copied Then',
    '  shell.Run """" & target & """", 1, False',
    'Else',
    '  errFile = fso.BuildPath(shell.ExpandEnvironmentStrings("%TEMP%"), "aegis-update-error.txt")',
    '  Set outFile = fso.CreateTextFile(errFile, True)',
    '  outFile.WriteLine "Aegis could not replace the old app file. Close it and run the update again."',
    '  outFile.Close',
    'End If',
    'fso.DeleteFile WScript.ScriptFullName, True',
    'WScript.Quit',
    '',
  ].join('\r\n');
}

export async function installUpdate(release, directory) {
  const target = process.env.PORTABLE_EXECUTABLE_FILE || process.env.AEGIS_EXE_PATH || '';
  if (!target) {
    throw new Error('Automatic updates only work in the packaged app.');
  }

  const source = path.join(directory, `Aegis-Control-${release.version}.exe`);
  await stat(source);

  const scriptPath = path.join(process.env.TEMP || directory, 'aegis-update.vbs');
  await writeFile(scriptPath, `\uFEFF${buildUpdateScript({ source, target })}`, 'utf16le');
  const child = spawn('wscript.exe', ['//B', '//Nologo', scriptPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return true;
}
