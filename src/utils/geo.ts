// export function validateLatLng(lat?: any, lng?: any) {
//     const nlat = Number(lat);
//     const nlng = Number(lng);
//     if (!Number.isFinite(nlat) || !Number.isFinite(nlng)) {
//         const e: any = new Error("lat/lng ต้องเป็นตัวเลข");
//         e.status = 400;
//         e.code = "BAD_LATLNG";
//         throw e;
//     }
//     if (nlat < -90 || nlat > 90 || nlng < -180 || nlng > 180) {
//         const e: any = new Error("lat/lng อยู่นอกช่วงพิกัดโลก");
//         e.status = 400;
//         e.code = "OUT_OF_RANGE";
//         throw e;
//     }
//     return { lat: nlat, lng: nlng };
// }
