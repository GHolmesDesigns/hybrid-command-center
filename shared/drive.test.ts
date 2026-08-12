import { describe, expect, it } from 'vitest';
import { DRIVE_FOLDER_MIME, driveFileKind, formatFileSize, isDriveFolder } from './drive.ts';

describe('Drive listing presentation', () => {
  it('names the kinds a studio actually keeps in Drive', () => {
    expect(driveFileKind(DRIVE_FOLDER_MIME)).toBe('Folder');
    expect(driveFileKind('application/vnd.google-apps.document')).toBe('Google Doc');
    expect(driveFileKind('application/pdf')).toBe('PDF');
    expect(driveFileKind('video/mp4')).toBe('Video');
    expect(driveFileKind('image/png')).toBe('Image');
    // An unknown type is still a file, not a blank cell.
    expect(driveFileKind('application/x-something-new')).toBe('File');
  });

  it('recognizes a folder by its mime type rather than by its name', () => {
    expect(isDriveFolder({ mimeType: DRIVE_FOLDER_MIME })).toBe(true);
    expect(isDriveFolder({ mimeType: 'application/pdf' })).toBe(false);
  });

  it('scales a size to the unit a person reads, and says nothing when Drive did not', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(900)).toBe('900 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(15_728_640)).toBe('15 MB');
    expect(formatFileSize(3_221_225_472)).toBe('3.0 GB');
    // Folders and Google-native documents report no size. That is not zero bytes.
    expect(formatFileSize(null)).toBe('—');
  });
});
