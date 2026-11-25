// three-gpu-pathtracer 的 WebGPU 版没有导出全景相机，从源码路径引入（包的 exports 允许 ./src/*），类型借用包根上的声明
declare module "three-gpu-pathtracer/src/objects/EquirectCamera.js" {
  export { EquirectCamera } from "three-gpu-pathtracer";
}
