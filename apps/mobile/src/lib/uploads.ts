import { Platform } from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'
import type { ImagePickerAsset } from 'expo-image-picker'
import { assertUploadSucceeded, type UploadMethod } from './upload-result'

export async function uploadPickedVideo(
  uploadUrl: string,
  asset: ImagePickerAsset,
  uploadMethod: UploadMethod = 'POST',
  uploadHeaders: Record<string, string> = {},
) {
  const mimeType = asset.mimeType ?? 'video/mp4'
  if (Platform.OS === 'web') {
    const blob = await fetch(asset.uri).then((response) => response.blob())
    if (uploadMethod === 'PUT') {
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { ...uploadHeaders, 'Content-Type': mimeType },
        body: blob,
      })
      assertUploadSucceeded(response.status, await response.text())
      return
    }
    const form = new FormData()
    form.append('file', blob, asset.fileName ?? 'clout.mp4')
    const response = await fetch(uploadUrl, { method: 'POST', headers: uploadHeaders, body: form })
    assertUploadSucceeded(response.status, await response.text())
    return
  }
  if (uploadMethod === 'PUT') {
    const response = await FileSystem.uploadAsync(uploadUrl, asset.uri, {
      httpMethod: 'PUT',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { ...uploadHeaders, 'Content-Type': mimeType },
    })
    assertUploadSucceeded(response.status, response.body)
    return
  }
  const response = await FileSystem.uploadAsync(uploadUrl, asset.uri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: 'file',
    mimeType,
    headers: uploadHeaders,
  })
  assertUploadSucceeded(response.status, response.body)
}
