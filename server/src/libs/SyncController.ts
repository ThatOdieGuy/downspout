import * as winston from "winston";

import logger from "./Logger";
const _ = require("lodash");
import * as fs from "fs";

const config = require('../Config');
import {FtpFile} from "../objects/FtpFile";
import {UserNotificationModel} from "../../../shared/models/UserNotificationModel";
import {UserNotificationController} from "./UserNotificationController";
import {UserNotification} from "../objects/UserNotification";

import {FtpController} from './FtpController';
import {FtpScanner, FtpScannerDelegate} from './FtpScanner';
import {FtpDownloader} from './FtpDownloader';
import {Utils} from "./Utils";
import RemoteDeleteQueue from "./RemoteDeleteQueue";

//TODO: Create new SyncController for every time we try to sync.
// This will prevent stuff like the FTP completed callbck from breaking when trying to access the downloadQueue which is missing.
class SyncController implements FtpScannerDelegate {
    private downloadQueue: FtpFile[] = [];
    private ftpScanner: FtpScanner = null;

    private pollingTimeoutId;

    private remoteDeleteQueue = new RemoteDeleteQueue();

    public syncRequest() {
        logger.info("syncRequest");

        UserNotificationController.getInstance().postNotification(new UserNotification("Sync Request received"));

        if (this.ftpScanner && this.ftpScanner.isScanning) {
            logger.info("Scan requested while scanning. Started: " + this.ftpScanner.startedAt.fromNow());
            return;
        }

        // Don't go hogging FTP connections to do deletes
        this.remoteDeleteQueue.pause();

        this.ftpScanner = new FtpScanner(this);

        this.ftpScanner.startScan();

        this.resetSyncTimer();
    }

    public resetSyncTimer() {
        clearInterval(this.pollingTimeoutId);

        this.pollingTimeoutId = setInterval(this.syncRequest.bind(this), config.seedboxFtp.pollingIntervalInSeconds * 1000);
    }

    public downloadsStatus() {
        let downloads = [];

        for (let file of this.downloadQueue) {
            downloads.push(file.toModel());
        }

        return downloads;
    }

    public status() {

        return {
            "stats": {
                "download_rate": 56.3,
                "max_download_rate": 5000001,
                "num_connections": 1,
                "max_num_connections": 2
            },
            "notifications": UserNotificationController.getInstance().getNotifications()
        };
    }

    public scannerComplete(err, scannedQueue: FtpFile[]) {
        if (err) {
            let message;

            switch (err.code) {
                case 530:
                    message = "Invalid FTP user or password";
                    break;
                default:
                   message = err.toString();
            }
            logger.error("scanCompleteCallback: " + message);

            UserNotificationController.getInstance().postNotification(new UserNotificationModel(message));

            return;
        }

        this.remoteDeleteQueue.start();
    }

    public scannerShouldProcessFile(file: FtpFile): boolean {
        // Don't process if already in the download queue.
        if (_.some(this.downloadQueue, otherFile => file.equals(otherFile))) {
            return false;
        }

        return true;
    }

    public scannerFileFound(file: FtpFile) {
        if (this.fileAlreadyDownloaded(file)) {
            this.addToRemoteDeleteQueue(file);
            return;
        }

        if (!_.some(this.downloadQueue, otherFile => file.equals(otherFile))) {
            logger.info("Adding " + file.fullPath + " to download queue");
            this.downloadQueue.push(file);

            // Trigger the downloads to start, if not already started.
            this.downloadNextInQueue();
        }
    }

    public fileAlreadyDownloaded(file: FtpFile): boolean {
        // Delete the file from FTP if it exists on disk
        // It will have a temporary file name if downloading or partial, so this safe.
        const path = FtpFile.appendSlash(this.getDestinationDirectory(file)) + Utils.sanitizeFtpPath(file.name);

        return fs.existsSync(path);
    }

    /**
     * Returns a file if there is one ready to download
     * This function is limited by how many free ftp connections there are
     *
     * @returns {FtpFile|null}
     */
    private getNextFileToDownload(): FtpFile {
        let downloadingCount = 0;
        let nextFile = null;

        for (let file of this.downloadQueue) {
            if (!file.downloading) {
                if (nextFile == null) {
                    nextFile = file;
                }
            } else {
                downloadingCount++;
            }
        }

        if (downloadingCount < config.downloads.countMax) {
            return nextFile;
        }

        return null;
    }

    /**
     * An item has been successfully downloaded, remove it from the queue
     *
     * @param ftpFile {FtpFile}
     * @param queue {FtpFile[]}
     */
    private removeFileFromQueue(ftpFile, queue) {
        for (let t = 0; t < queue.length; t++) {
            if (queue[t] == ftpFile) {
                queue.splice(t, 1);
            }
        }
    }

    /**
     * Given an FtpFile, will return the destination directory based on our path mappings
     *
     *  ex:
     *    FTP file: "/seedbox-sync/toUpload/tv/Some TV Show/episode 01.avi",
     *    localPath: "/microverse/library/seedbox/tv",
     *
     *  returns: "/microverse/library/seedbox/tv/Some TV Show/"
     *
     * @param file
     * @returns {string}
     */
    private getDestinationDirectory(file : FtpFile) : string {
        let remoteDirectory = file.relativeDirectory;

        let pathMap: PathMapping = null;

        if (config.pathMappings) {
            for (pathMap of config.pathMappings) {
                // We're going to be doing some comparison and removal with this path. Make sure it's good.
                let pathMapDirectory = FtpFile.appendSlash(pathMap.remotePath);

                if (remoteDirectory.indexOf(pathMapDirectory) == 0) {
                    //Strip the pathMap root from the remoteDirectory to get the relative mapping
                    let relativeDirectory = remoteDirectory.substring(pathMapDirectory.length);

                    return FtpFile.appendSlash(pathMap.localPath) + Utils.sanitizeFtpPath(relativeDirectory);
                }
            }
        }

        // Default value will be used if there are no matching path mappings
        return FtpFile.appendSlash(config.localSyncRoot) + Utils.sanitizeFtpPath(file.relativeDirectory);
    }

    /**
     * Download another item in the queue if it exists
     */
    private downloadNextInQueue() {
        let file : FtpFile;
        while ( file = this.getNextFileToDownload()) {
            let localDirectory = this.getDestinationDirectory(file);

            let ftpDownloader = new FtpDownloader(file, localDirectory);
            ftpDownloader.start(this.downloadDone.bind(this));
        }
    }

    private downloadDone(err, file: FtpFile) {
        if (!err) {
            this.addToRemoteDeleteQueue(file);
        }

        //TODO: Delete __seedbox_sync_folder__ file
        //TODO: Tell media server that files have been updated. If we've finished a section.

        if (!err) {
            UserNotificationController.getInstance().postNotification(new UserNotificationModel("Download completed " + file.name));
        }

        //Done, remove from queue.
        this.removeFileFromQueue(file, this.downloadQueue);

        this.downloadNextInQueue();
    }

    private addToRemoteDeleteQueue(file: FtpFile) {
        if (!config.deleteRemoteFiles) {
            logger.warn('deleteRemoteFiles is turned off');
            return;
        }

        this.remoteDeleteQueue.add(file);
    }
}

module.exports = new SyncController();