#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { platform } from 'os';

const parallel = process.argv.indexOf('--parallel') != -1;
const verbose = process.argv.indexOf('--verbose') != -1;

async function main() {
    await rm('artifacts');
    await cp('objects', 'artifacts');
    const objects = await getObjects('artifacts');
    await reprocessObjects(objects);
    await zipParkObjs(objects);
    await zipObjects();
}

async function zipObjects() {
    // Zip everything into a objects.zip
    console.log("Creating objects.zip");
    const root = 'artifacts';
    const directories = await getContents(root, {
        includeDirectories: true
    });
    await zip(root, 'objects.zip', directories, {
        recurse: true
    });
    for (const dir of directories) {
        await rm(path.join(root, dir));
    }
}

async function zipParkObj(obj) {
    console.log(`Creating ${obj.id}.parkobj`);
    // Zip the folder into a parkobj
    const files = await getContents(obj.cwd, {
        includeDirectories: true,
        includeFiles: true
    });
    await zip(obj.cwd, `../${obj.id}.parkobj`, files, {
        recurse: true
    });
    await rm(obj.cwd);
}

async function zipParkObjs(objects) {
    const zipObjs = [];
    for (const obj of objects) {
        var fullPath = path.join(obj.cwd, 'object.json');
        if (await fileExists(fullPath)) {
            if (parallel) {
                zipObjs.push(zipParkObj(obj));
            } else {
                await zipParkObj(obj);
            }
        }
    }
    await Promise.all(zipObjs);
}

async function reprocessObjects(objects) {
    const reprocessObjs = [];
    for (const obj of objects) {
        const images = obj.images;
        if (images === undefined) {
            continue;
        }
        var requiresProcessing = true;
        if (typeof images[Symbol.iterator] === 'function') {
            if (images.length === 0) requiresProcessing = false;
            for (const image of images) {
                if (typeof image === 'string') {
                    requiresProcessing = false;
                }
            }
        } else {
            requiresProcessing = false;
        }
        if (requiresProcessing) {
            if (parallel) {
                reprocessObjs.push(reprocessObject(obj));
            } else {
                await reprocessObject(obj);
            }
        }
    }
    await Promise.all(reprocessObjs);
}

async function getObjects(dir) {
    const result = [];
    const files = await getContents(dir, {
        includeFiles: true,
        recurse: true,
        useFullPath: true
    });
    for (const file of files) {
        const jsonRegex = /^.+\..+\.json$/;
        if (jsonRegex.test(file)) {
            const cwd = path.dirname(file);
            const obj = await readJsonFile(file);
            obj.cwd = cwd;
            result.push(obj);
        }
    }
    return result;
}

async function reprocessObject(obj) {
    console.log(`Reprocessing ${obj.id}`);
    const cwd = obj.cwd;
    await writeJsonFile(path.join(obj.cwd, 'images.json'), obj.images);
    await compileGx(obj.cwd, 'images.json', 'images.dat');
    var imageCount = await getGxImageCount(obj.cwd, 'images.dat');
    obj.images = `$LGX:images.dat[0..${imageCount - 1}]`;
    obj.cwd = undefined;
    await writeJsonFile(path.join(cwd, 'object.json'), obj);
    obj.cwd = cwd;
    await rm(path.join(cwd, 'images.json'));
    await rm(path.join(cwd, 'images'));
}

function compileGx(cwd, manifest, outputFile) {
    return startProcess('gxc', ['build', outputFile, manifest], cwd);
}

async function getGxImageCount(cwd, inputFile) {
    const stdout = await startProcess('gxc', ['details', inputFile], cwd);
    const result = stdout.match(/numEntries: ([0-9]+)/);
    if (result) {
        return parseInt(result[1]);
    } else {
        throw new Error(`Unable to get number of images for gx file: ${inputFile}`);
    }
}

function readJsonFile(path) {
    return new Promise((resolve, reject) => {
        fs.readFile(path, 'utf8', (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(JSON.parse(data));
            }
        });
    });
}

function writeJsonFile(path, data) {
    return new Promise((resolve, reject) => {
        const json = JSON.stringify(data, null, 4) + '\n';
        fs.writeFile(path, json, 'utf8', err => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

function getContents(root, options) {
    return new Promise((resolve, reject) => {
        const results = [];
        let pending = 0;
        const find = (root, relative) => {
            pending++;
            fs.readdir(root, (err, fileNames) => {
                for (const fileName of fileNames) {
                    const fullPath = path.join(root, fileName);
                    const relativePath = path.join(relative, fileName);
                    pending++;
                    fs.stat(fullPath, (err, stat) => {
                        if (stat) {
                            const result = options.useFullPath === true ? fullPath : relativePath;
                            if (stat.isDirectory()) {
                                if (options.includeDirectories === true) {
                                    results.push(result);
                                }
                                if (options.recurse === true) {
                                    find(fullPath, relativePath);
                                }
                            } else {
                                if (options.includeFiles === true) {
                                    results.push(result);
                                }
                            }
                        }
                        pending--;
                        if (pending === 0) {
                            resolve(results);
                        }
                    });
                }
                pending--;
                if (pending === 0) {
                    resolve(results.sort());
                }
            });
        };
        find(root, "");
    });
}

async function zip(cwd, outputFile, paths, options) {
    if (await fileExists(path.join(cwd, outputFile))) {
        await rm(outputFile);
    }
    const extraArgs = options && options.recurse ? ['-r'] : [];
    if (platform() == 'win32') {
        return startProcess('7z', ['a', '-tzip', ...extraArgs, outputFile, ...paths], cwd);
    } else {
        return startProcess('zip', [...extraArgs, outputFile, ...paths], cwd);
    }
}

function startProcess(name, args, cwd) {
    return new Promise((resolve, reject) => {
        const options = {};
        if (cwd) options.cwd = cwd;
        if (verbose) {
            console.log(`Launching \"${name} ${args.join(' ')}\" in \"${cwd}\"`);
        }
        const child = spawn(name, args, options);
        let stdout = '';
        child.stdout.on('data', data => {
            stdout += data;
        });
        child.stderr.on('data', data => {
            stdout += data;
        });
        child.on('error', err => {
            if (err.code == 'ENOENT') {
                reject(new Error(`${name} was not found`));
            } else {
                reject(err);
            }
        });
        child.on('close', code => {
            if (code !== 0) {
                reject(new Error(`${name} failed:\n${stdout}`));
            } else {
                resolve(stdout);
            }
        });
    });
}

function fileExists(path) {
    return new Promise(resolve => {
        fs.stat(path, (err, stat) => {
            resolve(!!stat);
        });
    });
}

function cp(src, dst) {
    if (verbose) {
        console.log(`Copying ${src} to ${dst}`)
    }
    fs.cpSync(src, dst, { recursive: true });
    return Promise.resolve();
}

function rm(filename) {
    if (verbose) {
        console.log(`Deleting ${filename}`)
    }
    return new Promise((resolve, reject) => {
        fs.stat(filename, (err, stat) => {
            if (err) {
                if (err.code == 'ENOENT') {
                    resolve();
                } else {
                    reject();
                }
            } else {
                if (stat.isDirectory()) {
                    fs.rm(filename, { recursive: true }, err => {
                        if (err) {
                            reject(err);
                        }
                        resolve();
                    });
                } else {
                    fs.unlink(filename, err => {
                        if (err) {
                            reject(err);
                        }
                        resolve();
                    });
                }
            }
        });
    });
}

try {
    await main();
} catch (err) {
    console.log(err.message);
    process.exitCode = 1;
}
