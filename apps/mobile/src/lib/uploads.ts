import { Platform } from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'
import type { ImagePickerAsset } from 'expo-image-picker'
import { assertUploadSucceeded } from './upload-result'

export async function uploadPickedVideo(uploadUrl: string, asset: ImagePickerAsset) {
  if (Platform.OS === 'web') {
    const blob = await fetch(asset.uri).then((response) => response.blob())
    const form = new FormData()
    form.append('file', blob, asset.fileName ?? 'clout.mp4')
    const response = await fetch(uploadUrl, { method: 'POST', body: form })
    assertUploadSucceeded(response.status, await response.text())
    return
  }
  const response = await FileSystem.uploadAsync(uploadUrl, asset.uri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: 'file',
    mimeType: asset.mimeType ?? 'video/mp4',
  })
  assertUploadSucceeded(response.status, response.body)
}
